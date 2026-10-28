package ai.factory.droidoffice.core

/**
 * The app's counted worker attachments (OfficeConnection): every attach is matched by one detach.
 * [generation] changes when they are all dropped at once (another office became active), so a hold
 * taken before that is already gone and must not be released again.
 */
interface SharedHolds {
    fun generation(): Long
    fun attach(workerId: String)
    fun detach(workerId: String)

    /** Asks for a fresh snapshot of a worker already attached. */
    fun resnapshot(workerId: String)
}

/**
 * One owner's holds on [shared] (a management page's join, the React Native side's raw sends): each
 * worker at most once, so a repeated attach asks for a fresh snapshot instead of stacking, and a
 * detach for a worker this owner doesn't hold is dropped rather than letting go of someone else's.
 * [release] lets go of exactly what this owner holds. Thread-safe.
 */
class OwnedHolds(private val shared: SharedHolds) {
    private val held = HashMap<String, Long>()

    @Synchronized fun attach(workerId: String) {
        val now = shared.generation()
        if (held[workerId] == now) {
            shared.resnapshot(workerId)
            return
        }
        held[workerId] = now
        shared.attach(workerId)
    }

    /** False when this owner didn't hold [workerId]: nothing was let go. */
    @Synchronized fun detach(workerId: String): Boolean {
        val at = held.remove(workerId) ?: return false
        if (at == shared.generation()) shared.detach(workerId)
        return true
    }

    @Synchronized fun release() {
        val now = shared.generation()
        for ((id, at) in held) if (at == now) shared.detach(id)
        held.clear()
    }

    @get:Synchronized val workers: Set<String> get() = held.keys.toSet()
}

/** Counted holds handed out as tokens (the React Native side's holdWorker): each releases once. Thread-safe. */
class HoldTokens(private val shared: SharedHolds) {
    private var next = 0L
    private val tokens = HashMap<Long, Pair<String, Long>>()

    @Synchronized fun hold(workerId: String): Long {
        val token = ++next
        tokens[token] = workerId to shared.generation()
        shared.attach(workerId)
        return token
    }

    @Synchronized fun release(token: Long) {
        val (id, at) = tokens.remove(token) ?: return
        if (at == shared.generation()) shared.detach(id)
    }

    @Synchronized fun releaseAll() {
        tokens.keys.toList().forEach(::release)
    }

    @get:Synchronized val size: Int get() = tokens.size
}
