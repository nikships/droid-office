plugins {
    `java-gradle-plugin`
    alias(libs.plugins.kotlin.jvm)
}

val rngp = rootDir.resolve("../../node_modules/@react-native/gradle-plugin")

sourceSets.main {
    kotlin.srcDirs(rngp.resolve("shared/src/main/kotlin"), rngp.resolve("settings-plugin/src/main/kotlin"))
}

group = "com.facebook.react"

gradlePlugin {
    plugins {
        create("reactSettings") {
            id = "com.facebook.react.settings"
            implementationClass = "com.facebook.react.ReactSettingsPlugin"
        }
    }
}

dependencies {
    implementation(libs.gson)
    implementation(libs.guava)
    implementation(libs.javapoet)
}

kotlin { jvmToolchain(21) }
