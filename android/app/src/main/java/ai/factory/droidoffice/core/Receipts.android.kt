package ai.factory.droidoffice.core

import java.io.File
import java.security.MessageDigest

fun Receipts(dir: File) = Receipts(object : ReceiptDirectory {
    override fun name(key: String) = MessageDigest.getInstance("SHA-256").digest(key.encodeToByteArray()).toHexString().take(32) + ".json"
    override fun read(name: String) = File(dir, name).takeIf { it.exists() }?.readText()
    override fun delete(name: String): Boolean = File(dir, name).let { !it.exists() || it.delete() }
    override fun files() = dir.listFiles { f -> f.isFile && f.name.endsWith(".json") }.orEmpty().associate { it.name to it.lastModified() }
    override fun replace(name: String, text: String) {
        check(dir.isDirectory || dir.mkdirs()) { "Couldn't create the receipt directory" }
        val tmp = File(dir, "$name.tmp")
        try {
            tmp.writeText(text)
            check(tmp.renameTo(File(dir, name))) { "Couldn't replace the receipt" }
        } finally {
            tmp.delete()
        }
    }
})
