package dev.porthex.portcode

// Android Application subclass — the entry point for process-wide initialisation.
//
// CONSENT CONTRACT (mirrors lib::telemetry_set_consent in Rust and the desktop
// before_send model):
//   • The Rust side writes `.telemetry_consent` in the Tauri app config dir, which
//     on Android is context.filesDir (Tauri's app_config_dir() maps there on mobile).
//   • This class reads that file DIRECTLY at process start, before the Tauri WebView
//     bridge is alive. The file IS the IPC between the Tauri settings UI and the
//     Android process. Opting in mid-session takes effect on the NEXT launch.
//   • Content trimmed == "1"  →  consent LIVE.
//   • File absent, unreadable, empty, or any other value  →  consent OFF (fail-safe).
//   • Sentry ONLY inits when consent is live AND BuildConfig.SENTRY_DSN is non-empty.
//     In developer/contributor/fork builds the DSN is an empty string, so Sentry is
//     always inert for those builds regardless of the consent file.
//
// PANIC → SIGABRT NOTE:
//   Cargo.toml [profile.release] sets panic="abort" globally (it cannot be set
//   per-target, and the desktop minidump relies on abort behaviour). A Rust panic on
//   Android therefore calls abort(), which raises SIGABRT. The Sentry Android NDK
//   signal handler catches SIGABRT and captures a native crash report, so a Rust
//   panic is NOT silent — it is reported as a native crash (NDK) event rather than
//   a JVM exception, and arrives in the Sentry dashboard under the "crash" issue
//   type. No additional Rust-side wiring is required.

import android.app.Application
import io.sentry.android.core.SentryAndroid
import java.io.File

class PortcodeApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        initSentryIfConsented()
    }

    private fun initSentryIfConsented() {
        val consented = readConsentFlag()
        val dsn = BuildConfig.SENTRY_DSN

        // Strict double-gate: both conditions must hold. Any IO failure in
        // readConsentFlag() returns false, so the default is always inert.
        if (!consented || dsn.isEmpty()) return

        SentryAndroid.init(this) { options ->
            options.dsn = dsn

            // Release string follows the same convention as the desktop host:
            // "portcode@<versionName>" derived from tauri.properties at build time.
            options.release = BuildConfig.VERSION_NAME

            // "debug" by default; "production" injected by CI when publishing.
            options.environment = BuildConfig.SENTRY_ENVIRONMENT

            // Privacy: never attach PII that Sentry would collect automatically.
            options.isSendDefaultPii = false
            options.isAttachServerName = false

            // Session tracking would expose session lengths; disable it.
            options.isEnableAutoSessionTracking = false

            // Screenshots and view hierarchies can contain user-generated content.
            options.isAttachScreenshot = false
            options.isAttachViewHierarchy = false

            // Cap breadcrumb ring-buffer; the scrubber drops the noisiest categories
            // (console, navigation, agent, llm, ipc) before they reach this limit.
            options.maxBreadcrumbs = 30

            // Privacy core: every outgoing event passes through the scrubber.
            // The scrubber strips PII-bearing fields and redacts survivors in one pass.
            options.setBeforeSend { event, _ -> SentryEventScrubber.scrubEvent(event) }

            // Privacy core for breadcrumbs: drops noisy categories, redacts messages.
            options.setBeforeBreadcrumb { crumb, _ -> SentryEventScrubber.scrubBreadcrumb(crumb) }
        }
    }

    /**
     * Read the consent flag written by the Rust telemetry_set_consent command.
     *
     * File: `<filesDir>/.telemetry_consent`
     * Contract: trimmed content == "1"  →  true.  Everything else (absent,
     * unreadable, empty, "0", corrupt)  →  false.  Any IOException  →  false.
     */
    private fun readConsentFlag(): Boolean {
        return try {
            val f = File(filesDir, ".telemetry_consent")
            f.exists() && f.readText().trim() == "1"
        } catch (_: Exception) {
            // Fail-safe: any IO error means no consent.
            false
        }
    }
}
