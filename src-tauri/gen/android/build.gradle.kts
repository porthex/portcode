buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
        // Sentry Gradle plugin — provides native-symbol upload and ProGuard mapping
        // upload tasks. Version pair (SDK 8.16.0 / plugin 5.8.0) must be confirmed
        // against AGP 8.11.0 by the android.yml CI probe before merging.
        classpath("io.sentry:sentry-android-gradle-plugin:5.8.0")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}

