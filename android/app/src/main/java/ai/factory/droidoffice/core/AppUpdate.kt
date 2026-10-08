package ai.factory.droidoffice.core

import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class AppRelease(
    val version: String,
    val versionCode: Int,
    val apk: UpdateApk? = null,
)

@Serializable
data class UpdateApk(val url: String, val size: Long, val sha256: String)

data class ApkIdentity(
    val packageName: String,
    val versionCode: Long,
    val version: String?,
    val minSdk: Int,
    val signers: Set<String>,
)

@Serializable
private data class GitHubRelease(
    @SerialName("tag_name") val tag: String,
    val draft: Boolean = false,
    val prerelease: Boolean = false,
    val assets: List<GitHubAsset> = emptyList(),
)

@Serializable
private data class GitHubAsset(
    val name: String,
    @SerialName("browser_download_url") val url: String = "",
    val size: Long = 0,
    val digest: String? = null,
    val state: String = "",
)

object AppUpdates {
    const val PACKAGE = "ai.factory.droidoffice"
    const val LATEST_URL = "https://github.com/nikships/droid-office/releases/latest"
    const val API_URL = "https://api.github.com/repos/nikships/droid-office/releases/latest"
    const val MAX_APK_BYTES = 150L * 1024 * 1024
    private val TAG = Regex("""v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)""")
    private val DIGEST = Regex("sha256:([a-fA-F0-9]{64})")

    /** CI uses the commit count as both the tag's last number and Android's versionCode. */
    fun available(json: String, installedCode: Int): AppRelease? {
        val release = OfficeJson.decodeFromString<GitHubRelease>(json)
        if (release.draft || release.prerelease) return null
        val match = TAG.matchEntire(release.tag) ?: throw IOException("The release version couldn't be read.")
        val code = match.groupValues[3].toIntOrNull() ?: throw IOException("The release version couldn't be read.")
        if (code <= installedCode) return null
        val version = release.tag.removePrefix("v")
        val name = "Droid-Office-$version.apk"
        val asset = release.assets.singleOrNull { it.name == name }
        val expectedUrl = "https://github.com/nikships/droid-office/releases/download/${release.tag}/$name"
        val hash = asset?.digest?.let { DIGEST.matchEntire(it)?.groupValues?.get(1)?.lowercase() }
        val apk = if (asset != null && asset.url == expectedUrl && asset.state == "uploaded" &&
            asset.size in 1..MAX_APK_BYTES && hash != null
        ) UpdateApk(asset.url, asset.size, hash) else null
        // A valid newer tag still offers the browser fallback if its APK isn't ready to install.
        return AppRelease(version, code, apk)
    }

    /** Stream a bounded APK, checking its immutable GitHub digest before making it installable. */
    fun copyVerified(input: InputStream, output: OutputStream, apk: UpdateApk, progress: (Long) -> Unit) {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(64 * 1024)
        var copied = 0L
        var reported = 0L
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            copied += n
            if (copied > apk.size || copied > MAX_APK_BYTES) throw IOException("The update download has the wrong size.")
            digest.update(buffer, 0, n)
            output.write(buffer, 0, n)
            if (copied - reported >= 256 * 1024) {
                progress(copied)
                reported = copied
            }
        }
        if (copied != apk.size) throw IOException("The update download was incomplete. Try again.")
        val hash = digest.digest().joinToString("") { "%02x".format(it) }
        if (hash != apk.sha256) throw IOException("The update download couldn't be verified. Try again.")
        progress(copied)
    }

    fun verifyIdentity(installed: ApkIdentity, archive: ApkIdentity, release: AppRelease, sdk: Int) {
        if (archive.packageName != installed.packageName || archive.versionCode != release.versionCode.toLong() ||
            archive.versionCode <= installed.versionCode || archive.version != release.version
        ) throw IOException("This APK isn't an update for this build. Download the release from GitHub instead.")
        if (archive.minSdk > sdk) throw IOException("This update needs a newer version of Android.")
        if (installed.signers.isEmpty() || archive.signers != installed.signers) {
            throw IOException("This build uses a different signing key. Download the release from GitHub instead.")
        }
    }
}

interface UpdateSource {
    suspend fun latest(): AppRelease?
    suspend fun download(release: AppRelease, progress: (Long) -> Unit): File
}
