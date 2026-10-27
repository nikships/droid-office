package ai.factory.droidoffice.core

import java.io.File
import java.security.MessageDigest

/**
 * This phone's receipts for messages it sent to workers' Droid queues, kept on disk so a restart or
 * force-stop brings them back: one file per `officeId/floorId/workerId` holding that worker's
 * [ThreadQueue] snapshot, its key on the first line. Only workers with receipts still unconfirmed
 * have a file, at most [MAX_WORKERS] of them (the least recently written go first). Every call is
 * blocking and safe to make from any thread; a disk error is reported, never thrown.
 */
class Receipts(private val dir: File) {
    enum class Saved {
        /** On disk as given. */
        Kept,
        /** Nothing left to keep, and none on disk. */
        Removed,
        /** Larger than [MAX_CHARS]: not on disk, and any older copy removed so it can't come back stale. */
        TooLarge,
        /** The disk refused it; whatever was there before was removed if it could be. */
        Failed,
    }

    sealed interface Loaded {
        data class Found(val snapshot: String?) : Loaded
        data class Failed(val reason: String) : Loaded
    }

    private val lock = Any()

    fun load(key: String): Loaded = synchronized(lock) {
        try {
            val file = file(key)
            if (!file.exists()) return Loaded.Found(null)
            val text = file.readText()
            val head = text.substringBefore('\n')
            // A name collision or a half-written file: not this worker's receipts.
            if (head != key || '\n' !in text) Loaded.Found(null) else Loaded.Found(text.substringAfter('\n'))
        } catch (e: Exception) {
            Loaded.Failed(e.message ?: e.javaClass.simpleName)
        }
    }

    /** Keeps [snapshot] for [key], or removes the file when it's null. */
    fun save(key: String, snapshot: String?): Saved = synchronized(lock) {
        val file = file(key)
        try {
            if (snapshot == null) {
                if (file.exists() && !file.delete()) return Saved.Failed
                return Saved.Removed
            }
            if (snapshot.length > MAX_CHARS) {
                file.delete()
                return Saved.TooLarge
            }
            if (!dir.isDirectory && !dir.mkdirs()) return Saved.Failed
            // Written beside it and renamed over it, so a crash mid-write leaves the old copy or none.
            val temp = File(dir, file.name + ".tmp")
            temp.writeText(key + "\n" + snapshot)
            if (!temp.renameTo(file)) {
                temp.delete()
                file.delete()
                return Saved.Failed
            }
            trim()
            Saved.Kept
        } catch (e: Exception) {
            runCatching { file.delete() }
            Saved.Failed
        }
    }

    /** Forgets every worker's receipts in the office [officeId]. */
    fun removeOffice(officeId: String) = synchronized(lock) {
        files().forEach { f -> if (runCatching { f.useLines { it.firstOrNull() } }.getOrNull()?.startsWith("$officeId/") == true) f.delete() }
    }

    private fun trim() {
        files().sortedByDescending { it.lastModified() }.drop(MAX_WORKERS).forEach { it.delete() }
    }

    private fun files(): List<File> = dir.listFiles { f -> f.isFile && f.name.endsWith(".json") }?.toList().orEmpty()

    private fun file(key: String): File {
        val hash = MessageDigest.getInstance("SHA-256").digest(key.toByteArray()).joinToString("") { "%02x".format(it) }
        return File(dir, hash.take(32) + ".json")
    }

    companion object {
        const val MAX_WORKERS = 12
        /** The largest snapshot [ThreadQueue] reads back; a larger one couldn't be restored anyway. */
        const val MAX_CHARS = 800_000

        /**
         * Whether [queue]'s receipts would all come back from [snapshot]: [ThreadQueue] drops what it
         * can't restore (a message over its length limit, say), and that has to be said, not hidden.
         */
        fun restorable(queue: ThreadQueue, snapshot: String): Boolean =
            snapshot.length <= MAX_CHARS && ThreadQueue(snapshot).pending.map { it.text to it.hasImage } == queue.pending.map { it.text to it.hasImage }

        /**
         * The queue to use once the disk has answered: what [loaded] holds, with every receipt the
         * owner made in [early] while it was being read (or before the office and floor were known)
         * added after them, in order, so none is lost. [early] must not have been synced.
         */
        fun merge(loaded: ThreadQueue, early: ThreadQueue): ThreadQueue {
            for (p in early.pending) loaded.sent(p.text, p.hasImage, p.after)
            return loaded
        }
    }
}
