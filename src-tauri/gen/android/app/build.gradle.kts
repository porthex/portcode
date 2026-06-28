import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
    // Sentry Gradle plugin: wires native-symbol and ProGuard upload tasks into
    // the AGP build pipeline. Applied AFTER the Android plugin per plugin ordering
    // requirements. Auto-init is disabled below so the SDK never inits before our
    // consent check in PortcodeApplication.
    id("io.sentry.android.gradle")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "dev.porthex.portcode"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "dev.porthex.portcode"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")

        // DSN injected from CI secret SENTRY_DSN; empty in contributor/fork builds
        // → PortcodeApplication.initSentryIfConsented() treats empty DSN as inert.
        buildConfigField("String", "SENTRY_DSN",
            "\"${System.getenv("SENTRY_DSN") ?: ""}\"")
        // "debug" unless the CI publish workflow injects "production".
        buildConfigField("String", "SENTRY_ENVIRONMENT",
            "\"${System.getenv("SENTRY_ENVIRONMENT") ?: "debug"}\"")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    // Sentry Android SDK — bundles sentry-android-core + sentry-android-ndk.
    // The NDK integration registers signal handlers (incl. SIGABRT) so Rust
    // panics (which abort() via profile.release panic="abort") are captured as
    // native crash events. Version must be confirmed against AGP 8.11.0 in CI.
    implementation("io.sentry:sentry-android:8.16.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

// ---------------------------------------------------------------------------
// Sentry Gradle plugin configuration
// ---------------------------------------------------------------------------
// IMPORTANT — auto-init must be suppressed so the plugin does NOT inject a
// SentryInitProvider that would initialise the SDK at process start, before
// PortcodeApplication.onCreate() runs our consent check.
//
// In plugin 5.x the relevant DSL options are:
//   autoInstallation.enabled  — controls whether the plugin adds the Sentry SDK
//       dependency automatically. We manage the dep ourselves (above), so this
//       is set to false to avoid a duplicate-dependency conflict.
//   The plugin's SentryInitProvider auto-init behaviour in 5.x is controlled by
//       the io.sentry.auto-init manifest meta-data entry. We do NOT set it to
//       "true"; omitting it (or leaving it default "false" / absent) means no
//       auto-init. PortcodeApplication is the sole init site.
//
// *** VERIFY in CI: confirm that plugin 5.8.0 does not inject
//     io.sentry.auto-init=true into the merged manifest automatically.
//     If it does, add a manifestPlaceholders override or an explicit
//     <meta-data android:name="io.sentry.auto-init" android:value="false"/>
//     in AndroidManifest.xml to suppress it. ***
sentry {
    // Do not let the plugin add a duplicate sentry-android dependency.
    autoInstallation {
        enabled.set(false)
    }

    // ProGuard/R8 mapping upload: disabled for now (no Sentry project wired yet).
    // Enable once SENTRY_PROJECT + SENTRY_ORG secrets are provisioned.
    autoUploadProguardMapping.set(false)
    includeProguardMapping.set(false)

    // Native (NDK) symbol upload is gated on SENTRY_AUTH_TOKEN being present in
    // the environment. Contributor/fork builds that lack the secret produce no
    // upload attempt and the probe stays green. CI publish builds supply the token.
    // NOTE: only `uploadNativeSymbols` is set. `autoUploadNativeSymbols` existed in
    // plugin 4.x but is NOT a confirmed 5.x DSL property; referencing a missing
    // property fails the Gradle configuration phase hard, so we keep just the
    // confirmed one (upload is a no-op anyway without SENTRY_AUTH_TOKEN).
    val sentryAuthToken = System.getenv("SENTRY_AUTH_TOKEN")
    uploadNativeSymbols.set(sentryAuthToken != null)
}

apply(from = "tauri.build.gradle.kts")