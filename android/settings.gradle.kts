pluginManagement {
    // The React Native Gradle plugin, built from the root package's node_modules (npm ci) at the version
    // package-lock.json pins, so the native runtime always matches the bundled JavaScript.
    includeBuild("react-native-plugin")
    repositories {
        google {
            content {
                includeGroupByRegex("androidx.*")
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    // The React Native plugin adds the same repositories to each project as well; those are ignored
    // in favour of these.
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        google {
            content {
                includeGroupByRegex("androidx.*")
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
            }
        }
        mavenCentral()
    }
}

plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
    id("com.facebook.react.settings")
}

extensions.configure<com.facebook.react.ReactSettingsExtension> { autolinkLibrariesFromCommand(workingDirectory = file("..")) }

rootProject.name = "droid-office-android"
include(":app")
