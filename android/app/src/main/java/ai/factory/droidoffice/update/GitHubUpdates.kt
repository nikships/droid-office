package ai.factory.droidoffice.update

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import ai.factory.droidoffice.BuildConfig
import ai.factory.droidoffice.core.AppRelease
import ai.factory.droidoffice.core.AppUpdates
import ai.factory.droidoffice.core.ApkIdentity
import ai.factory.droidoffice.core.UpdateSource
import ai.factory.droidoffice.net.CleartextGuard
import ai.factory.droidoffice.net.await
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Cache
import okhttp3.CacheControl
import okhttp3.OkHttpClient
import okhttp3.Request

/** Public GitHub requests never share an office's client, cookies or device token. */
class GitHubUpdates(private val context: Context) : UpdateSource {
    private val client = OkHttpClient.Builder()
        .addNetworkInterceptor(CleartextGuard())
        .addNetworkInterceptor { chain ->
            if (!chain.request().url.isHttps) throw IOException("Updates need a secure connection.")
            chain.proceed(chain.request())
        }
        .followSslRedirects(false)
        .cache(Cache(File(context.cacheDir, "update-http"), 1024 * 1024))
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(20, TimeUnit.SECONDS)
        .build()
    private val downloads = client.newBuilder().cache(null).callTimeout(5, TimeUnit.MINUTES).build()
    private val directory = File(context.cacheDir, "updates")

    override suspend fun latest(): AppRelease? = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(AppUpdates.API_URL)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", "Droid-Office-Android/${BuildConfig.VERSION_NAME}")
            .cacheControl(CacheControl.Builder().maxAge(0, TimeUnit.SECONDS).build())
            .build()
        client.newCall(request).await().use { response ->
            if (!response.isSuccessful) throw IOException("Couldn't check GitHub for updates.")
            // Releases contain notes and other assets, but must not consume unbounded memory.
            val source = response.body.source()
            source.request(1024 * 1024 + 1L)
            val text = source.readByteArray(source.buffer.size.coerceAtMost(1024 * 1024 + 1L))
            if (text.size > 1024 * 1024) throw IOException("The release answer was too large.")
            AppUpdates.available(text.toString(Charsets.UTF_8), BuildConfig.VERSION_CODE)
        }
    }

    override suspend fun download(release: AppRelease, progress: (Long) -> Unit): File = withContext(Dispatchers.IO) {
        val apk = release.apk ?: throw IOException("Download this release from GitHub instead.")
        if (!directory.isDirectory && !directory.mkdirs()) throw IOException("Couldn't make room for the update.")
        val file = File(directory, "Droid-Office-${release.version}.apk")
        val coroutine = currentCoroutineContext()
        if (file.isFile) {
            val valid = runCatching {
                file.inputStream().use { input ->
                    AppUpdates.copyVerified(input, object : OutputStream() {
                        override fun write(b: Int) = Unit
                        override fun write(b: ByteArray, off: Int, len: Int) = Unit
                    }, apk) { coroutine.ensureActive() }
                }
                verifyPackage(file, release)
            }.isSuccess
            coroutine.ensureActive()
            if (valid) return@withContext file
            file.delete()
        }
        // Only this updater's APKs and partial downloads live in this private directory.
        directory.listFiles()?.filter { it.name.startsWith("Droid-Office-") && (it.extension == "apk" || it.extension == "part") }
            ?.forEach { it.delete() }
        val partial = File(directory, "${file.name}.part")
        val call = downloads.newCall(Request.Builder().url(apk.url).build())
        val cancel = launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                awaitCancellation()
            } finally {
                call.cancel()
            }
        }
        try {
            call.await().use { response ->
                if (!response.isSuccessful) throw IOException("Couldn't download the update. Try again.")
                val length = response.body.contentLength()
                if (length >= 0 && length != apk.size) throw IOException("The update download has the wrong size.")
                response.body.byteStream().use { input ->
                    partial.outputStream().use { output ->
                        AppUpdates.copyVerified(input, output, apk) { bytes ->
                            coroutine.ensureActive()
                            progress(bytes)
                        }
                    }
                }
            }
            coroutine.ensureActive()
            verifyPackage(partial, release)
            if (!partial.renameTo(file)) throw IOException("Couldn't save the update. Try again.")
            file
        } finally {
            cancel.cancel()
            partial.delete()
        }
    }

    /** Refuse a different app, signing key, SDK requirement or version before opening Android's installer. */
    private fun verifyPackage(file: File, release: AppRelease) {
        val manager = context.packageManager
        val archive = manager.getPackageArchiveInfo(file.path, PackageManager.GET_SIGNING_CERTIFICATES)
            ?: throw IOException("Android couldn't read the update. Download it from GitHub instead.")
        val installed = manager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        AppUpdates.verifyIdentity(installed.identity(), archive.identity(), release, android.os.Build.VERSION.SDK_INT)
    }
}

private fun PackageInfo.identity() = ApkIdentity(
    packageName, longVersionCode, versionName,
    applicationInfo?.minSdkVersion ?: Int.MAX_VALUE,
    signingInfo?.apkContentsSigners?.map { it.toCharsString() }?.toSet().orEmpty(),
)
