// Redaction for the telemetry `before_send` hook — the privacy core of Rust-host
// crash reporting. Portcode holds OAuth tokens, keyring/Noise secrets, and API
// keys, and streams prompts/code/shell I/O through the agent; NONE of that may
// ever reach Sentry. We therefore take an ALLOWLIST stance (in `telemetry.rs`): an
// outgoing event is rebuilt from a small set of known-safe fields, and then every
// surviving string is run through `redact_secrets` as belt-and-suspenders. This
// module imports nothing from Sentry, so it can't itself emit and is trivially
// unit-tested — it is the faithful Rust port of the Phase-1a `src/lib/scrub.ts`.
//
// Philosophy: over-redact. A false-positive redaction costs a slightly less
// precise stack frame; a false negative leaks a user's secret. We always choose
// the former.

use std::sync::OnceLock;

use regex::Regex;

/// Hard cap on a string before regex work. Two jobs: (1) bounds any regex so a
/// giant crash string can't stall (defense-in-depth alongside Rust's regex crate,
/// which is already non-backtracking / linear by construction, so ReDoS is not a
/// concern), and (2) prevents an accidental full-file/full-prompt dump from riding
/// out inside an exception message.
const MAX_REDACT_LEN: usize = 2048;

/// One ordered redaction pass: a compiled pattern + its replacement template.
/// Rust's `regex` replacement syntax uses `${1}` (vs JS `$1`) — required here
/// because every backreference below is immediately followed by `[`, which would
/// otherwise be swallowed into an (empty) `$1[...]` group name.
struct Redactor {
    re: Regex,
    repl: &'static str,
}

/// Ordered redaction passes. Specific secrets first, then identifying paths, then
/// a catch-all for key-shaped blobs. Applied to EVERY string we keep. Compiled
/// once and cached — never recompiled per call.
///
/// Regex notes (mirrors scrub.ts; Rust `regex` is linear/non-backtracking):
///  - The email pattern uses dot-free labels (`[A-Za-z0-9-]+` joined by literal
///    `\.`) so the domain side can't ambiguously overlap the TLD.
///  - The key catch-all has NO `\b` anchor (a `\b` is absent between two word
///    chars, so a key glued to a preceding identifier would escape) and includes
///    base64URL chars (`-` `_`) plus hex — so Noise/iroh/JWT keys all match.
fn redactors() -> &'static [Redactor] {
    static REDACTORS: OnceLock<Vec<Redactor>> = OnceLock::new();
    REDACTORS.get_or_init(|| {
        // Each `Regex::new` is on a fixed, hand-written pattern that is verified to
        // compile; `expect` here can only fire on a programmer error in this file
        // (caught the first time any test or call runs), never on user input.
        let p = |pat: &str, repl: &'static str| Redactor {
            re: Regex::new(pat).expect("scrub: invalid redaction regex"),
            repl,
        };
        vec![
            // Anthropic keys (sk-ant-oat…/sk-ant-api…) — tolerant of base64url `-_`.
            p(r"sk-ant-[A-Za-z0-9_-]{6,}", "[redacted-api-key]"),
            // Other `sk-` provider keys (OpenAI sk-proj_…, etc.). Leading `\b` so we
            // don't chew "sk-" inside an ordinary hyphenated word like "task-…"; no
            // trailing `\b` (it fails next to `_`/`-`), tolerant of `_-`.
            p(r"\bsk-[A-Za-z0-9_-]{12,}", "[redacted-api-key]"),
            // Bearer token values. (?i) = case-insensitive, mirroring the JS /gi.
            p(
                r"(?i)\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*",
                "${1}[redacted-token]",
            ),
            // Authorization / x-api-key / api-key header or assignment values.
            p(
                r#"(?i)("?(?:authorization|x-api-key|api[_-]?key)"?\s*[:=]\s*"?)[^"\s,}\]]+"#,
                "${1}[redacted]",
            ),
            // Emails (non-overlapping labels).
            p(
                r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}",
                "[redacted-email]",
            ),
            // IPv4 addresses.
            p(r"\b\d{1,3}(?:\.\d{1,3}){3}\b", "[redacted-ip]"),
            // User-identifying home directories → keep the shape, drop the username.
            //   C:\Users\Alice\…  ·  C:/Users/Alice/…
            p(r"(?i)([A-Za-z]:[\\/]Users[\\/])[^\\/]+", "${1}~user"),
            //   /home/alice/…  ·  /Users/alice/…
            p(r"(/(?:home|Users)/)[^/]+", "${1}~user"),
            //   Android app-private dirs: /data/data/<pkg>/…  ·  /data/user/0/<pkg>/…
            p(r"(/data/(?:data|user/\d+)/)[^/]+", "${1}~app"),
            // Key-shaped blobs (≥40 chars): standard base64, base64url (`-_`), or hex
            // — Noise/iroh keys, JWTs, tokens. No `\b` so word-char-adjacent keys
            // still match.
            p(r"[A-Za-z0-9+/_-]{40,}={0,2}", "[redacted-key]"),
        ]
    })
}

/// Run every redaction pass over a string. Caps length first (dump guard), then
/// applies each pass in order. Safe on any string.
pub fn redact_secrets(value: &str) -> String {
    // Cap by CHARS (not bytes) so we never split a UTF-8 codepoint. This mirrors the
    // JS `slice(0, MAX_REDACT_LEN)` which is also codepoint(-ish)-aware.
    let capped = value.chars().count() > MAX_REDACT_LEN;
    let mut out: String = if capped {
        value.chars().take(MAX_REDACT_LEN).collect()
    } else {
        value.to_string()
    };
    for r in redactors() {
        // `replace_all` returns Cow; only allocate when something actually matched.
        out = r.re.replace_all(&out, r.repl).into_owned();
    }
    if capped {
        out.push_str("…[truncated]");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // The scrubber is the privacy gate for crash reporting — these tests are the
    // SHARED CONTRACT that secrets NEVER survive into an outgoing event. They mirror
    // `src/lib/scrub.test.ts` and reuse its planted values.

    #[test]
    fn redacts_anthropic_and_generic_sk_keys() {
        assert_eq!(
            redact_secrets("key sk-ant-api03-abcDEF_12-34 end"),
            "key [redacted-api-key] end"
        );
        assert_eq!(
            redact_secrets("sk-0123456789abcdefABCDEF"),
            "[redacted-api-key]"
        );
    }

    #[test]
    fn redacts_bearer_tokens_and_auth_headers() {
        assert!(redact_secrets("Authorization: Bearer abc.def-ghi123").contains("[redacted-token]"));
        assert!(redact_secrets(r#""x-api-key":"supersecretvalue""#).contains("[redacted]"));
    }

    #[test]
    fn redacts_emails() {
        assert_eq!(
            redact_secrets("contact a667066706670@gmail.com now"),
            "contact [redacted-email] now"
        );
    }

    #[test]
    fn strips_the_username_from_home_directories_on_every_os_shape() {
        assert_eq!(
            redact_secrets(r"C:\Users\Memphi$\dev\app"),
            r"C:\Users\~user\dev\app"
        );
        assert_eq!(
            redact_secrets("C:/Users/Alice/file.ts"),
            "C:/Users/~user/file.ts"
        );
        assert_eq!(redact_secrets("/home/alice/code/x"), "/home/~user/code/x");
        assert_eq!(redact_secrets("/Users/bob/x"), "/Users/~user/x");
        assert_eq!(
            redact_secrets("/data/data/dev.porthex.portcode/files"),
            "/data/data/~app/files"
        );
        assert_eq!(
            redact_secrets("/data/user/0/dev.porthex.portcode/x"),
            "/data/user/0/~app/x"
        );
    }

    #[test]
    fn redacts_key_shaped_base64_blobs() {
        let key = "QStvZ2VuZXJhdGVkbG9uZ2Jhc2U2NGtleXZhbHVlMTIzNDU2Nzg5MA==";
        assert_eq!(redact_secrets(&format!("pub={key}")), "pub=[redacted-key]");
    }

    #[test]
    fn redacts_base64url_keys_and_keys_glued_to_a_word_char() {
        // 44-char base64url key containing - and _.
        let url_key = "ab-CD_efGHijKLmnOPqrSTuvWXyz0123456789-_ABCD";
        assert_eq!(redact_secrets(&format!("k={url_key}")), "k=[redacted-key]");
        // No \b: a key immediately preceded by a word char must still be caught.
        assert!(redact_secrets(&format!("token{url_key}")).contains("[redacted-key]"));
        assert!(!redact_secrets(&format!("token{url_key}")).contains(url_key));
    }

    #[test]
    fn redacts_hex_node_ids_and_ipv4_addresses() {
        assert!(
            redact_secrets("node e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b")
                .contains("[redacted-key]")
        );
        assert_eq!(
            redact_secrets("relay 192.168.1.42:443"),
            "relay [redacted-ip]:443"
        );
    }

    #[test]
    fn redacts_non_anthropic_sk_keys_containing_underscore_or_dash() {
        assert_eq!(
            redact_secrets("sk-proj_aB3dEf_GhIjKlMnOpQr"),
            "[redacted-api-key]"
        );
        // but does not chew 'sk-' inside an ordinary hyphenated word.
        assert_eq!(
            redact_secrets("task-management-system-design"),
            "task-management-system-design"
        );
    }

    #[test]
    fn caps_very_long_strings_so_a_giant_dump_cant_ride_out() {
        let huge = format!("noreply@{}", "a".repeat(50_000));
        let out = redact_secrets(&huge);
        assert!(out.chars().count() < 3000);
        assert!(out.ends_with("…[truncated]"));
    }

    #[test]
    fn leaves_ordinary_text_untouched() {
        let s = "TypeError: cannot read property 'x' of undefined";
        assert_eq!(redact_secrets(s), s);
    }

    // The cross-cutting contract: feed one string laced with every kind of planted
    // secret and assert NONE survive (the Rust analogue of scrubEvent's
    // "never lets any planted secret survive anywhere" test).
    #[test]
    fn no_planted_secret_survives_a_combined_string() {
        let combined = concat!(
            "boom sk-ant-msg-leak123456 ",
            "provider sk-0123456789abcdef0123 ",
            "Authorization: Bearer abc.def-ghi123 ",
            r#""x-api-key":"sk-ant-headerleak123456" "#,
            "mail a667066706670@gmail.com ",
            "ip 1.2.3.4 ",
            r"path C:\Users\Memphi$\secret ",
            "home /home/alice/secret ",
            "blob QStvZ2VuZXJhdGVkbG9uZ2Jhc2U2NGtleXZhbHVlMTIzNDU2Nzg5MA=="
        );
        let out = redact_secrets(combined);
        for secret in [
            "sk-ant-msg-leak123456",
            "sk-0123456789abcdef0123",
            "abc.def-ghi123",
            "sk-ant-headerleak123456",
            "a667066706670@gmail.com",
            "1.2.3.4",
            "Memphi$",
            "alice",
            "QStvZ2VuZXJhdGVkbG9uZ2Jhc2U2NGtleXZhbHVlMTIzNDU2Nzg5MA",
        ] {
            assert!(
                !out.contains(secret),
                "secret survived redaction: {secret} -> {out}"
            );
        }
        // Non-secret framing words are preserved.
        assert!(out.contains("boom"));
        assert!(out.contains("provider"));
    }
}
