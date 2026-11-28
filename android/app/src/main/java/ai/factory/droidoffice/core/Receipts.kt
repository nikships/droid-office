package ai.factory.droidoffice.core

import ai.factory.droidoffice.data.PhoneLock

internal interface ReceiptDirectory {
    fun name(key: String): String
    fun read(name: String): String?
    fun replace(name: String, text: String)
    fun delete(name: String): Boolean
    /** Names of receipt files and their last write times. */
    fun files(): Map<String, Long>
}

/**
 * This phone's receipts for messages it sent to workers' Droid queues, kept on disk so a restart or
 * force-stop brings them back: one file per `officeId/floorId/workerId` holding that worker's
 * [ThreadQueue] snapshot, its key on the first line. Only workers with receipts still unconfirmed
 * have a file, at most [MAX_WORKERS] of them (the least recently written go first). Every call is
 * blocking and safe to make from any thread; a disk error is reported, never thrown.
 */
class Receipts internal constructor(private val dir: ReceiptDirectory) {
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

    private val lock = PhoneLock()

    fun load(key: String): Loaded = lock.withLock {
        try {
            val text = dir.read(dir.name(key)) ?: return Loaded.Found(null)
            val head = text.substringBefore('\n')
            // A name collision or a half-written file: not this worker's receipts.
            if (head != key || '\n' !in text) Loaded.Found(null) else Loaded.Found(text.substringAfter('\n'))
        } catch (e: Exception) {
            Loaded.Failed(e.message ?: "Couldn't read this worker's receipts")
        }
    }

    /** Keeps [snapshot] for [key], or removes the file when it's null. */
    fun save(key: String, snapshot: String?): Saved = lock.withLock {
        val file = dir.name(key)
        try {
            if (snapshot == null) return if (dir.delete(file)) Saved.Removed else Saved.Failed
            if (snapshot.length > MAX_CHARS) {
                return if (dir.delete(file)) Saved.TooLarge else Saved.Failed
            }
            dir.replace(file, key + "\n" + snapshot)
            dir.files().entries.sortedByDescending { it.value }.drop(MAX_WORKERS).forEach { dir.delete(it.key) }
            Saved.Kept
        } catch (e: Exception) {
            runCatching { dir.delete(file) }
            Saved.Failed
        }
    }

    /** Forgets every worker's receipts in the office [officeId]. */
    fun removeOffice(officeId: String) = lock.withLock {
        dir.files().keys.forEach { f -> if (runCatching { dir.read(f) }.getOrNull()?.startsWith("$officeId/") == true) dir.delete(f) }
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
