// React Native's Gradle plugins, compiled from the sources npm installs (package-lock.json pins them) with
// this app's Kotlin. Their own build in node_modules targets an older Kotlin that cannot read this
// Gradle's Kotlin runtime. `settings` is applied in settings.gradle.kts, so it must not carry the Android
// Gradle plugin; `app` compiles against it and gets it from the app's own classpath.
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
    versionCatalogs { create("libs") { from(files("../gradle/libs.versions.toml")) } }
}

rootProject.name = "react-native-plugin"
include(":settings", ":app")
