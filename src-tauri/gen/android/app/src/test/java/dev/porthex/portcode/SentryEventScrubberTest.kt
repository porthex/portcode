package dev.porthex.portcode

// JUnit4 unit tests for SentryEventScrubber.redactSecrets — mirrors the
// contract in src-tauri/src/scrub.rs and src/lib/scrub.test.ts.
//
// These tests exercise the pure string-scrubbing logic only and have ZERO
// dependency on an Android emulator, device, or the Sentry SDK runtime.
// They run with `./gradlew :app:test` (host JVM) in CI.
//
// Contract: every planted secret must be absent from the output;
// non-secret framing words must be preserved.

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SentryEventScrubberTest {

    // Convenience alias.
    private fun scrub(s: String) = SentryEventScrubber.redactSecrets(s)

    // -------------------------------------------------------------------------
    // 1. Anthropic API key (sk-ant-…)
    // -------------------------------------------------------------------------

    @Test
    fun `sk-ant key is redacted`() {
        assertEquals(
            "key [redacted-api-key] end",
            scrub("key sk-ant-api03-abcDEF_12-34 end")
        )
    }

    @Test
    fun `sk-ant key with varied suffix is redacted`() {
        assertTrue(scrub("sk-ant-oat03-ABCDEFGHIJ0123").contains("[redacted-api-key]"))
    }

    // -------------------------------------------------------------------------
    // 2. Generic sk- provider keys (OpenAI-style)
    // -------------------------------------------------------------------------

    @Test
    fun `generic sk- key is redacted`() {
        assertEquals("[redacted-api-key]", scrub("sk-0123456789abcdefABCDEF"))
    }

    @Test
    fun `sk- key with underscore suffix is redacted`() {
        assertEquals("[redacted-api-key]", scrub("sk-proj_aB3dEf_GhIjKlMnOpQr"))
    }

    @Test
    fun `ordinary hyphenated word starting with task-sk is not redacted`() {
        // "sk-" appears after a word char — \b guard must prevent a match.
        // (The word "task-management" doesn't start with the \b-sk- pattern.)
        assertEquals(
            "task-management-system-design",
            scrub("task-management-system-design")
        )
    }

    // -------------------------------------------------------------------------
    // 3. Bearer tokens
    // -------------------------------------------------------------------------

    @Test
    fun `Bearer token value is redacted while preserving the keyword`() {
        val out = scrub("Authorization: Bearer abc.def-ghi123")
        assertTrue(out.contains("[redacted-token]"))
        assertFalse(out.contains("abc.def-ghi123"))
    }

    // -------------------------------------------------------------------------
    // 4. Authorization / x-api-key header values
    // -------------------------------------------------------------------------

    @Test
    fun `x-api-key header value is redacted`() {
        val out = scrub(""""x-api-key":"supersecretvalue"""")
        assertTrue(out.contains("[redacted]"))
        assertFalse(out.contains("supersecretvalue"))
    }

    // -------------------------------------------------------------------------
    // 5. Email addresses
    // -------------------------------------------------------------------------

    @Test
    fun `email address is redacted`() {
        assertEquals(
            "contact [redacted-email] now",
            scrub("contact a667066706670@gmail.com now")
        )
    }

    @Test
    fun `email with plus addressing is redacted`() {
        assertTrue(scrub("user+tag@example.org").contains("[redacted-email]"))
    }

    // -------------------------------------------------------------------------
    // 6. IPv4 addresses
    // -------------------------------------------------------------------------

    @Test
    fun `IPv4 address is redacted`() {
        assertEquals("relay [redacted-ip]:443", scrub("relay 192.168.1.42:443"))
    }

    // -------------------------------------------------------------------------
    // 7. Windows user home paths
    // -------------------------------------------------------------------------

    @Test
    fun `Windows backslash user path is scrubbed`() {
        assertEquals(
            "C:\\Users\\~user\\dev\\app",
            scrub("C:\\Users\\Memphi\$\\dev\\app")
        )
    }

    @Test
    fun `Windows forward-slash user path is scrubbed`() {
        assertEquals("C:/Users/~user/file.ts", scrub("C:/Users/Alice/file.ts"))
    }

    // -------------------------------------------------------------------------
    // 8. Unix home paths
    // -------------------------------------------------------------------------

    @Test
    fun `unix home path is scrubbed`() {
        assertEquals("/home/~user/code/x", scrub("/home/alice/code/x"))
    }

    @Test
    fun `macOS Users path is scrubbed`() {
        assertEquals("/Users/~user/x", scrub("/Users/bob/x"))
    }

    // -------------------------------------------------------------------------
    // 9. Android data-dir paths
    // -------------------------------------------------------------------------

    @Test
    fun `Android data-data path is scrubbed`() {
        assertEquals(
            "/data/data/~app/files",
            scrub("/data/data/dev.porthex.portcode/files")
        )
    }

    @Test
    fun `Android data-user path is scrubbed`() {
        assertEquals(
            "/data/user/0/~app/x",
            scrub("/data/user/0/dev.porthex.portcode/x")
        )
    }

    // -------------------------------------------------------------------------
    // 10. Key-shaped base64 / hex blobs
    // -------------------------------------------------------------------------

    @Test
    fun `base64 key blob is redacted`() {
        val key = "QStvZ2VuZXJhdGVkbG9uZ2Jhc2U2NGtleXZhbHVlMTIzNDU2Nzg5MA=="
        assertEquals("pub=[redacted-key]", scrub("pub=$key"))
    }

    @Test
    fun `base64url key with dash and underscore is redacted`() {
        val urlKey = "ab-CD_efGHijKLmnOPqrSTuvWXyz0123456789-_ABCD"
        assertEquals("k=[redacted-key]", scrub("k=$urlKey"))
    }

    @Test
    fun `key immediately glued to a word char is still caught`() {
        val urlKey = "ab-CD_efGHijKLmnOPqrSTuvWXyz0123456789-_ABCD"
        val out = scrub("token$urlKey")
        assertTrue(out.contains("[redacted-key]"))
        assertFalse(out.contains(urlKey))
    }

    @Test
    fun `hex node id is redacted`() {
        val out = scrub("node e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b")
        assertTrue(out.contains("[redacted-key]"))
    }

    // -------------------------------------------------------------------------
    // Length cap
    // -------------------------------------------------------------------------

    @Test
    fun `very long string is capped and truncation marker appended`() {
        val huge = "noreply@" + "a".repeat(50_000)
        val out = scrub(huge)
        assertTrue(out.length < 3000)
        assertTrue(out.endsWith("…[truncated]"))
    }

    // -------------------------------------------------------------------------
    // Ordinary text is left alone
    // -------------------------------------------------------------------------

    @Test
    fun `ordinary error message is unchanged`() {
        val s = "TypeError: cannot read property 'x' of undefined"
        assertEquals(s, scrub(s))
    }

    // -------------------------------------------------------------------------
    // Combined / cross-cutting contract:
    // Feed one string laced with every kind of planted secret and assert NONE
    // survive while non-secret framing words are preserved.
    // This is the primary regression guard — if ANY pattern is broken, this
    // catches it in a single test.
    // -------------------------------------------------------------------------

    @Test
    fun `no planted secret survives a combined string`() {
        val combined = buildString {
            append("boom sk-ant-msg-leak123456 ")
            append("provider sk-0123456789abcdef0123 ")
            append("Authorization: Bearer abc.def-ghi123 ")
            append(""""x-api-key":"sk-ant-headerleak123456" """)
            append("mail a667066706670@gmail.com ")
            append("ip 1.2.3.4 ")
            append("path C:\\Users\\Memphi\$\\secret ")
            append("home /home/alice/secret ")
            append("android /data/data/dev.porthex.portcode/x ")
            append("blob QStvZ2VuZXJhdGVkbG9uZ2Jhc2U2NGtleXZhbHVlMTIzNDU2Nzg5MA==")
        }

        val out = scrub(combined)

        val secrets = listOf(
            "sk-ant-msg-leak123456",
            "sk-0123456789abcdef0123",
            "abc.def-ghi123",
            "sk-ant-headerleak123456",
            "a667066706670@gmail.com",
            "1.2.3.4",
            "Memphi\$",
            "alice",
            "dev.porthex.portcode",      // Android package in data path
            "QStvZ2VuZXJhdGVkbG9uZ2Jhc2U2NGtleXZhbHVlMTIzNDU2Nzg5MA"
        )

        for (secret in secrets) {
            assertFalse(
                "Secret survived redaction: '$secret' found in: $out",
                out.contains(secret)
            )
        }

        // Non-secret framing words are preserved.
        assertTrue("framing word 'boom' was removed", out.contains("boom"))
        assertTrue("framing word 'provider' was removed", out.contains("provider"))
        assertTrue("framing word 'mail' was removed", out.contains("mail"))
    }
}
