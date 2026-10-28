plugins {
    `java-gradle-plugin`
    alias(libs.plugins.kotlin.jvm)
}

val rngp = rootDir.resolve("../../node_modules/@react-native/gradle-plugin")

sourceSets.main {
    kotlin.srcDirs(rngp.resolve("shared/src/main/kotlin"), rngp.resolve("react-native-gradle-plugin/src/main/kotlin"))
}

group = "com.facebook.react"

gradlePlugin {
    plugins {
        create("react") {
            id = "com.facebook.react"
            implementationClass = "com.facebook.react.ReactPlugin"
        }
    }
}

dependencies {
    // The app's build already has these, at the versions in libs.versions.toml.
    compileOnly(libs.android.gradle)
    compileOnly(libs.kotlin.gradle)
    implementation(libs.gson)
    implementation(libs.guava)
    implementation(libs.javapoet)
}

kotlin { jvmToolchain(21) }
