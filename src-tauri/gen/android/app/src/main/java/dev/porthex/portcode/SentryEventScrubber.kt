package dev.porthex.portcode

// Privacy core for Sentry Android crash reporting — faithful Kotlin port of
// src-tauri/src/scrub.rs. Philosophy: over-redact. A false-positive redaction
// costs a slightly less precise stack frame; a false negative leaks a user's
// secret. We always choose the former.
//
// Patterns, ordering, and replacement strings are the CANONICAL CONTRACT shared
// with scrub.rs and src/lib/scrub.ts. Any change here must be mirrored there.

import io.sentry.Breadcrumb
import io.sentry.SentryEvent
import io.sentry.protocol.Request
import java.util.regex.Pattern

object SentryEventScrubber {

    // Hard cap on a string before regex work: prevents an accidental full-prompt
    // dump from riding out inside an exception message, and bounds regex work.
    const val MAX_REDACT_LEN = 2048

    // Ordered redaction passes compiled once at object initialisation, not per call.
    // Java replacement syntax uses $1 (not ${1}); $1[ is unambiguous because [ is
    // literal in a Java replacement string, so the bracket is never consumed as part
    // of a group name.
    private data class Redactor(val pattern: Pattern, val replacement: String)

    private val REDACTORS: List<Redactor> = listOf(
        // 1. Anthropic keys (sk-ant-oat…/sk-ant-api…) — tolerant of base64url -_
        Redactor(
            Pattern.compile("sk-ant-[A-Za-z0-9_-]{6,}"),
            "[redacted-api-key]"
        ),
        // 2. Other sk- provider keys (OpenAI sk-proj_…, etc.). Leading \b so we
        //    don't chew "sk-" inside a hyphenated word like "task-…".
        Redactor(
            Pattern.compile("\\bsk-[A-Za-z0-9_-]{12,}"),
            "[redacted-api-key]"
        ),
        // 3. Bearer token values. (?i) = case-insensitive.
        Redactor(
            Pattern.compile("(?i)\\b(Bearer\\s+)[A-Za-z0-9._~+/\\-]+=*"),
            "\$1[redacted-token]"
        ),
        // 4. Authorization / x-api-key / api-key header or assignment values.
        Redactor(
            Pattern.compile("(?i)(\"?(?:authorization|x-api-key|api[_-]?key)\"?\\s*[:=]\\s*\"?)[^\"\\s,}\\]]+"),
            "\$1[redacted]"
        ),
        // 5. Email addresses (non-overlapping labels).
        Redactor(
            Pattern.compile("[A-Za-z0-9._%+\\-]+@[A-Za-z0-9\\-]+(?:\\.[A-Za-z0-9\\-]+)*\\.[A-Za-z]{2,}"),
            "[redacted-email]"
        ),
        // 6. IPv4 addresses.
        Redactor(
            Pattern.compile("\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b"),
            "[redacted-ip]"
        ),
        // 7. Windows user home dirs: C:\Users\Alice\… or C:/Users/Alice/…
        Redactor(
            Pattern.compile("(?i)([A-Za-z]:[/\\\\]Users[/\\\\])[^/\\\\]+"),
            "\$1~user"
        ),
        // 8. Unix user home dirs: /home/alice/… or /Users/alice/…
        Redactor(
            Pattern.compile("(/(?:home|Users)/)[^/]+"),
            "\$1~user"
        ),
        // 9. Android app-private dirs: /data/data/<pkg>/… or /data/user/0/<pkg>/…
        Redactor(
            Pattern.compile("(/data/(?:data|user/\\d+)/)[^/]+"),
            "\$1~app"
        ),
        // 10. Key-shaped blobs (≥40 chars): base64, base64url (-_), or hex.
        //     No \b — a key immediately preceded by a word char must still be caught.
        Redactor(
            Pattern.compile("[A-Za-z0-9+/_-]{40,}={0,2}"),
            "[redacted-key]"
        )
    )

    /**
     * Cap [value] to [MAX_REDACT_LEN] characters (appending "…[truncated]" if
     * capped), then run every ordered redaction pass. Safe on any input string.
     */
    fun redactSecrets(value: String): String {
        val capped = value.length > MAX_REDACT_LEN
        var out = if (capped) value.substring(0, MAX_REDACT_LEN) else value
        for (r in REDACTORS) {
            out = r.pattern.matcher(out).replaceAll(r.replacement)
        }
        if (capped) out += "…[truncated]"
        return out
    }

    /**
     * Strip PII carriers then redact all surviving strings in a [SentryEvent].
     *
     * Strip strategy (mirrors telemetry.rs allowlist logic):
     * - Hard-null fields that are PII by definition (serverName, user, request).
     * - Clear extras/tags maps (may hold arbitrary key→value pairs from the app).
     * - Remove the "device" context entry (carries hostname).
     * - Redact message text and all exception values.
     * - Redact stack frame filenames/modules; null absolute paths and source context.
     *
     * Returns the same [event] object (mutated in-place) for chaining.
     */
    fun scrubEvent(event: SentryEvent): SentryEvent {
        // Strip PII-by-definition carriers.
        event.serverName = null
        event.user = null
        event.request = null

        // Clear extras and tags — arbitrary string maps that could hold anything.
        event.extras?.clear()
        event.tags?.clear()

        // Remove device context (carries hostname and other hardware identifiers).
        event.contexts?.remove("device")

        // Redact the human-readable message.
        event.message?.let { msg ->
            msg.formatted = msg.formatted?.let { redactSecrets(it) }
            msg.message = msg.message?.let { redactSecrets(it) }
        }

        // Redact exception values and their stack frames.
        event.exceptions?.forEach { ex ->
            ex.value = ex.value?.let { redactSecrets(it) }
            ex.stacktrace?.frames?.forEach { frame -> scrubFrame(frame) }
        }

        // Redact stack frames in any attached threads.
        event.threads?.forEach { thread ->
            thread.stacktrace?.frames?.forEach { frame -> scrubFrame(frame) }
        }

        // event.breadcrumbs is intentionally NOT re-scrubbed here: every breadcrumb
        // already passes through scrubBreadcrumb() via the beforeBreadcrumb hook,
        // which is registered atomically with beforeSend in PortcodeApplication (the
        // sole init site) — so none can reach an event unredacted.
        return event
    }

    /**
     * Scrub a single [io.sentry.protocol.SentryStackFrame]: null out absolute
     * paths and source-context lines (too likely to carry code snippets), redact
     * filename and module, keep function/lineno/colno/inApp which are needed for
     * deduplication but carry no secrets.
     */
    private fun scrubFrame(frame: io.sentry.protocol.SentryStackFrame) {
        frame.absPath = null
        frame.contextLine = null
        frame.preContext = null
        frame.postContext = null
        @Suppress("DEPRECATION")
        frame.vars = null
        frame.filename = frame.filename?.let { redactSecrets(it) }
        frame.module = frame.module?.let { redactSecrets(it) }
        // frame.function, frame.lineno, frame.colno, frame.isInApp — kept as-is.
    }

    // Breadcrumb categories that are dropped wholesale because they can carry
    // agent output, LLM payloads, navigation paths, or IPC data.
    private val DROPPED_CATEGORIES = setOf("console", "navigation", "agent", "llm", "ipc")

    /**
     * Scrub a [Breadcrumb] before it is attached to a Sentry event.
     *
     * Returns null (dropped) if the category is in the deny-list; otherwise
     * redacts the message, clears arbitrary data, and returns the breadcrumb.
     */
    fun scrubBreadcrumb(b: Breadcrumb): Breadcrumb? {
        if (b.category in DROPPED_CATEGORIES) return null
        b.message = b.message?.let { redactSecrets(it) }
        b.data.clear()
        return b
    }
}
