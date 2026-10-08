package ai.factory.droidoffice.core

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class AppUpdateTest {
    private val hash = "a".repeat(64)
    private fun release(code: String = "10", asset: String = apk(code), extra: String = "") =
        """{"tag_name":"v0.1.$code","assets":[$asset]$extra}"""
    private fun apk(code: String = "10") =
        """{"name":"Droid-Office-0.1.$code.apk","browser_download_url":"https://github.com/nikships/droid-office/releases/download/v0.1.$code/Droid-Office-0.1.$code.apk","size":20,"state":"uploaded","digest":"sha256:$hash"}"""

    @Test fun newerReleaseUsesTheAndroidVersionCodeNotTextOrdering() {
        val found = AppUpdates.available(release(), 9)!!
        assertEquals(AppRelease("0.1.10", 10, UpdateApk(
            "https://github.com/nikships/droid-office/releases/download/v0.1.10/Droid-Office-0.1.10.apk", 20, hash,
        )), found)
    }

    @Test fun sameAndOlderVersionsNeverOfferADowngrade() {
        assertNull(AppUpdates.available(release(), 10))
        assertNull(AppUpdates.available(release(), 100))
    }

    @Test fun draftAndPrereleaseAreIgnored() {
        assertNull(AppUpdates.available(release(extra = ""","draft":true"""), 1))
        assertNull(AppUpdates.available(release(extra = ""","prerelease":true"""), 1))
    }

    @Test fun malformedVersionsAndAnswersDoNotClaimTheAppIsCurrent() {
        for (tag in listOf("v0.1.010", "v0.1.10-beta", "v0.1.2147483648", "v0.1.10/elsewhere", "latest")) {
            assertThrows(IOException::class.java) { AppUpdates.available("""{"tag_name":"$tag"}""", 1) }
        }
        assertThrows(Exception::class.java) { AppUpdates.available("<html>unavailable</html>", 1) }
    }

    @Test fun anotherMajorOrMinorStillUsesCIsGlobalCommitCount() {
        assertEquals("1.2.10", AppUpdates.available("""{"tag_name":"v1.2.10"}""", 9)?.version)
    }

    @Test fun missingOrAmbiguousApkOffersTheNewerReleaseWithBrowserFallback() {
        for (assets in listOf("", """{"name":"mac.zip"}""", apk() + "," + apk())) {
            val found = AppUpdates.available(release(asset = assets), 1)!!
            assertEquals("0.1.10", found.version)
            assertNull(found.apk)
        }
    }

    @Test fun downloadUrlMustBeTheExactApkOnOurForksRelease() {
        for (url in listOf(
            "http://github.com/nikships/droid-office/releases/download/v0.1.10/Droid-Office-0.1.10.apk",
            "https://github.com/AgentSystemLabs/agent-office/releases/download/v0.1.10/Droid-Office-0.1.10.apk",
            "https://github.com.evil.test/nikships/droid-office/releases/download/v0.1.10/Droid-Office-0.1.10.apk",
        )) {
            val changed = apk().replace(Regex("https://[^\"]+"), url)
            assertNull(AppUpdates.available(release(asset = changed), 1)!!.apk)
        }
    }

    @Test fun digestSizeAndUploadStateMustBeInstallable() {
        for (asset in listOf(
            apk().replace("sha256:$hash", "md5:$hash"),
            apk().replace("sha256:$hash", "sha256:abc"),
            apk().replace(""""size":20""", """"size":0"""),
            apk().replace(""""size":20""", """"size":${AppUpdates.MAX_APK_BYTES + 1}"""),
            apk().replace("uploaded", "new"),
            apk().replace(""","digest":"sha256:$hash"""", ""),
        )) assertNull(AppUpdates.available(release(asset = asset), 1)!!.apk)
        assertNotNull(AppUpdates.available(release(asset = apk().replace(hash, hash.uppercase())), 1)!!.apk)
    }

    @Test fun unknownReleaseFieldsDoNotBreakUpdateChecks() {
        assertNotNull(AppUpdates.available(release(extra = ""","body":"release notes","future":{"value":true}"""), 1))
    }

    private val bytes = ByteArray(700_000) { (it % 251).toByte() }
    private val download = UpdateApk("unused", bytes.size.toLong(), MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })

    @Test fun downloadStreamsWithProgressAndChecksItsDigest() {
        val output = ByteArrayOutputStream()
        val progress = mutableListOf<Long>()
        AppUpdates.copyVerified(bytes.inputStream(), output, download) { progress += it }
        assertEquals(bytes.toList(), output.toByteArray().toList())
        assertEquals(bytes.size.toLong(), progress.last())
        assertEquals(progress.sorted(), progress)
    }

    @Test fun truncatedOversizedAndCorruptDownloadsAreRejected() {
        for (bad in listOf(bytes.dropLast(1).toByteArray(), bytes + byteArrayOf(1), bytes.copyOf().also { it[0] = 42 })) {
            assertThrows(IOException::class.java) {
                AppUpdates.copyVerified(bad.inputStream(), ByteArrayOutputStream(), download) {}
            }
        }
    }

    private val installed = ApkIdentity(AppUpdates.PACKAGE, 9, "0.1.9", 28, setOf("release"))
    private val archive = installed.copy(versionCode = 10, version = "0.1.10")
    private val newer = AppRelease("0.1.10", 10)

    @Test fun matchingNewerSignedApkIsAccepted() {
        AppUpdates.verifyIdentity(installed, archive, newer, 28)
    }

    @Test fun wrongPackageVersionSdkAndSigningKeyAreRejected() {
        for (bad in listOf(
            archive.copy(packageName = "${AppUpdates.PACKAGE}.debug"),
            archive.copy(versionCode = 11),
            archive.copy(version = "0.1.11"),
            archive.copy(minSdk = 35),
            archive.copy(signers = setOf("debug")),
            archive.copy(signers = emptySet()),
        )) assertThrows(IOException::class.java) { AppUpdates.verifyIdentity(installed, bad, newer, 34) }
        assertThrows(IOException::class.java) { AppUpdates.verifyIdentity(archive, archive, newer, 34) }
        assertThrows(IOException::class.java) { AppUpdates.verifyIdentity(installed.copy(signers = emptySet()), archive, newer, 34) }
    }
}
