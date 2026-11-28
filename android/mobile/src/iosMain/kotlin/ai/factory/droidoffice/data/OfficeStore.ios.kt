@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package ai.factory.droidoffice.data

import ai.factory.droidoffice.core.OfficeJson
import ai.factory.droidoffice.core.ReceiptDirectory
import ai.factory.droidoffice.core.Receipts
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.reinterpret
import kotlinx.cinterop.usePinned
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.IO
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import platform.CoreCrypto.CC_SHA256
import platform.CoreCrypto.CC_SHA256_DIGEST_LENGTH
import platform.Foundation.*

private val files = NSFileManager.defaultManager

fun OfficeStore(scope: CoroutineScope): OfficeStore {
    val support = checkNotNull(files.URLForDirectory(NSApplicationSupportDirectory, NSUserDomainMask, null, true, null))
    val dir = checkNotNull(support.URLByAppendingPathComponent("DroidOffice", isDirectory = true))
    check(files.createDirectoryAtURL(dir, true, null, null) && dir.setResourceValue(true, NSURLIsExcludedFromBackupKey, null))
    val root = checkNotNull(dir.path)
    return OfficeStore(ApplePreferences("$root/offices.json"), scope, TokenVault(), Receipts(AppleReceiptDirectory("$root/receipts")))
}

private fun readText(path: String): String? {
    if (!files.fileExistsAtPath(path)) return null
    return checkNotNull(NSData.dataWithContentsOfFile(path)) { "Couldn't read the saved file" }.toBytes().decodeToString()
}

private fun replace(path: String, text: String) {
    check(text.encodeToByteArray().toData().writeToFile(path, atomically = true)) { "Couldn't save the file" }
}

/** Small metadata file only; receipt bodies and the actual credentials never enter it. */
private class ApplePreferences(private val path: String) : OfficePreferences {
    private val current = MutableStateFlow(readText(path)?.let { OfficeJson.decodeFromString<Map<String, String>>(it) }.orEmpty())
    override val data = current.asStateFlow()
    private val mutex = Mutex()

    override suspend fun edit(change: (MutableMap<String, String>) -> Unit) = withContext(Dispatchers.IO) {
        mutex.withLock {
            val next = current.value.toMutableMap().also(change)
            if (next != current.value) {
                replace(path, OfficeJson.encodeToString(next))
                current.value = next
            }
        }
    }
}

private class AppleReceiptDirectory(private val dir: String) : ReceiptDirectory {
    override fun name(key: String): String {
        val bytes = key.encodeToByteArray()
        val digest = ByteArray(CC_SHA256_DIGEST_LENGTH)
        digest.usePinned { out -> bytes.usePinned { input ->
            CC_SHA256(if (bytes.isEmpty()) null else input.addressOf(0), bytes.size.toUInt(), out.addressOf(0).reinterpret())
        } }
        return digest.toHexString(0, 16) + ".json"
    }

    override fun read(name: String) = readText("$dir/$name")
    override fun replace(name: String, text: String) {
        check(files.createDirectoryAtPath(dir, true, null, null)) { "Couldn't create the receipt directory" }
        ai.factory.droidoffice.data.replace("$dir/$name", text)
    }
    override fun delete(name: String) = !files.fileExistsAtPath("$dir/$name") || files.removeItemAtPath("$dir/$name", null)
    override fun files(): Map<String, Long> = files.contentsOfDirectoryAtPath(dir, null).orEmpty()
        .filterIsInstance<String>().filter { it.endsWith(".json") }.associateWith { name ->
            val date = files.attributesOfItemAtPath("$dir/$name", null)?.get(NSFileModificationDate) as? NSDate
            ((date?.timeIntervalSince1970 ?: 0.0) * 1000).toLong()
        }
}
