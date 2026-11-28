plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.compose.compiler)
}

// Use the Android resource names in the shared Compose screens. Xcode copies these same files
// as folder references, so adding artwork never requires a second iOS resource catalogue.
val resourceNames = tasks.register("generateAppleResourceNames") {
    val pictures = layout.projectDirectory.dir("../app/src/main/res/drawable-nodpi").asFileTree.matching { include("*.webp") }
    val glyph = layout.projectDirectory.file("../app/src/main/res/values/glyph.xml")
    val generated = layout.buildDirectory.dir("generated/appleResources")
    inputs.files(pictures, glyph)
    outputs.dir(generated)
    doLast {
        val names = pictures.files.sortedBy { it.name }.joinToString("\n") { "        const val ${it.nameWithoutExtension} = \"drawable-nodpi/${it.name}\"" }
        val path = glyph.asFile.readText().substringAfter("translatable=\"false\">").substringBefore("</string>")
        generated.get().file("R.kt").asFile.apply {
            parentFile.mkdirs()
            writeText("package ai.factory.droidoffice\n\ninternal object R {\n    object drawable {\n        const val ic_glyph = \"ic_glyph\"\n$names\n    }\n    const val glyphPath = \"$path\"\n}\n")
        }
    }
}

kotlin {
    listOf(iosArm64(), iosSimulatorArm64()).forEach { target ->
        target.binaries.framework {
            baseName = "OfficeMobile"
            isStatic = true
        }
    }

    sourceSets {
        iosMain {
            kotlin.srcDir(resourceNames)
            // Compile the actual phone screens; only platform services and native views differ.
            kotlin.source(objects.sourceDirectorySet("phone", "Production mobile sources").apply {
                srcDir("../app/src/main/java")
                include("**/ui/**", "**/session/**", "**/data/OfficeStore.kt", "**/data/ArtworkPreference.kt", "**/net/OfficeApi.kt", "**/net/OfficeTransport.kt", "**/core/Receipts.kt")
                exclude("**/*.android.kt", "**/*Android.kt", "**/UpdateUi.kt", "**/NotifyPermission.kt",
                    "**/FloorOrderHint.kt", "**/TerminalPage.kt", "**/TerminalKeyboard.kt", "**/RichBlock.kt", "**/CardPage.kt")
            })
            dependencies {
                implementation(project(":core"))
                implementation(libs.mobile.ui)
                implementation(libs.mobile.foundation)
                implementation(libs.mobile.material)
                implementation(libs.mobile.icons)
                implementation(libs.mobile.lifecycle)
                implementation(libs.mobile.navigation)
            }
        }
    }
}
