package ai.factory.droidoffice.core

import kotlin.time.Clock
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient

private fun nowMs(): Long = Clock.System.now().toEpochMilliseconds()

/**
 * The messages this phone sent to Droid's queue, held until the conversation shows them, as the web
 * holds them (src/shared/thread-queue.ts). Droid's own queue, read off its screen ([DroidQueue]), is
 * what the thread shows: these only fill in the whole text of a row Droid cut short, and stand in
 * for it while the screen can't be read.
 */
class ThreadQueue(saved: String? = null) {
    @Serializable
    data class Prompt(val id: Int, val text: String, val hasImage: Boolean, val after: Long, val at: Long = 0) {
        /** When Droid's queue last showed it on the screen. */
        @Transient var seen: Long = 0
    }

    /** One message waiting for its turn, as the thread shows it. [preview] when only Droid's cut-short row is known. */
    data class Shown(val key: String, val text: String, val hasImage: Boolean, val preview: Boolean, val more: Int)

    @Serializable
    private data class Saved(val session: String?, val sequence: Long, val items: List<Prompt>, val consumed: List<String>)
    private var session: String? = null
    private var serial = 0
    private val consumed = HashSet<String>()
    var sequence: Long = -1
        private set
    var pending: List<Prompt> = emptyList()
        private set

    init {
        val state = saved?.takeIf { it.length <= 800_000 }?.let { runCatching { OfficeJson.decodeFromString(Saved.serializer(), it) }.getOrNull() }
        if (state != null) {
            session = state.session
            sequence = state.sequence
            pending = state.items.takeLast(32).filter { it.id > 0 && it.text.length <= 20_000 }
            serial = pending.maxOfOrNull { it.id } ?: 0
            consumed += state.consumed.takeLast(2000)
        }
    }

    fun snapshot(): String = OfficeJson.encodeToString(Saved.serializer(), Saved(session, sequence, pending, consumed.toList()))

    fun sent(text: String, hasImage: Boolean, after: Long = sequence, at: Long = nowMs()) {
        pending = (pending + Prompt(++serial, text, hasImage, after, at)).takeLast(32)
    }

    /** Forgets every message here, after Droid's queue was cleared. */
    fun clear() {
        pending = emptyList()
        consumed.clear()
    }

    fun sync(sessionId: String?, entries: List<ThreadEntry>): List<Prompt> {
        if (sessionId != null && session != null && sessionId != session) {
            pending = emptyList()
            consumed.clear()
            sequence = -1
        }
        if (sessionId != null) session = sessionId
        for (entry in entries) sequence = maxOf(sequence, entry.seq)
        for (entry in entries.sortedBy { it.seq }) {
            if (entry.role != ThreadRole.User || entry.id in consumed) continue
            var matched = false
            for (start in pending.indices) {
                if (matched) break
                var joined = ""
                for (end in start until pending.size) {
                    val item = pending[end]
                    if (entry.seq <= item.after) break
                    // Droid can drain consecutive queued text sends as one user message, without a separator.
                    joined += item.text
                    // A prompt the office sent with pictures arrives as its own text, the pictures beside it (or alone).
                    val match = if (item.text.isNotEmpty()) entry.kind == ThreadKind.Text && entry.text?.trim() == joined
                    else start == end && item.hasImage &&
                        ((entry.kind == ThreadKind.Notice && entry.text == ThreadView.IMAGE_PLACEHOLDER) || (entry.kind == ThreadKind.Text && entry.text.isNullOrBlank() && entry.images.isNotEmpty()))
                    if (match) {
                        pending = pending.filterIndexed { index, _ -> index !in start..end }
                        consumed += entry.id
                        matched = true
                        break
                    }
                    if (item.text.isEmpty()) break
                }
            }
        }
        if (pending.isEmpty()) consumed.clear()
        return pending
    }

    /**
     * What waits in the queue now, oldest first. With Droid's queue read off the screen, its rows,
     * each with the whole text of the message here it previews, then messages sent too recently for
     * Droid to have drawn them. A message here that Droid hasn't shown for [GRACE_MS] has left the
     * queue, drained or cleared, and is forgotten. Without the screen ([droid] null), every message here.
     */
    fun shown(droid: List<DroidQueue.Row>?, now: Long = nowMs()): List<Shown> {
        fun own(p: Prompt) = Shown("sent:${p.id}", p.text, p.hasImage, preview = false, more = 0)
        if (droid == null) return pending.map(::own)
        val used = HashSet<Int>()
        val out = droid.mapIndexed { i, row ->
            val p = pending.firstOrNull { it.id !in used && DroidQueue.showsAs(row, it.text) }
            if (p == null) {
                Shown("droid:$i:${row.text}", row.text, hasImage = false, preview = row.cut || row.more > 0, more = row.more)
            } else {
                used += p.id
                p.seen = now
                own(p)
            }
        }.toMutableList()
        pending = pending.filter { it.id in used || now - maxOf(it.at, it.seen) < GRACE_MS }
        for (p in pending) if (p.id !in used) out += own(p)
        if (pending.isEmpty()) consumed.clear()
        return out
    }

    /**
     * Factory's queued messages panel: what Droid's screen shows as sent mid-turn (steering, read at
     * its next step) and, after it, what waits for the turn's end, each queued one with the whole
     * text sent from here when this phone sent it.
     */
    data class Panel(val steering: List<Item>, val queued: List<Item>, val moreSteering: Int = 0, val moreQueued: Int = 0, val review: Boolean = false) {
        /** [index] is its place in its [group], from 0, as Droid's queue review counts it. */
        data class Item(val key: String, val group: DroidQueue.Group, val index: Int, val text: String, val hasImage: Boolean, val preview: Boolean, val more: Int)
        val items get() = steering + queued
        val total get() = steering.size + queued.size + moreSteering + moreQueued
        val isEmpty get() = total == 0

        companion object {
            val EMPTY = Panel(emptyList(), emptyList())
        }
    }

    /** [shown] split into Droid's groups: [droid] null when its screen doesn't say, so all that is known is what was queued from here. */
    fun panel(droid: DroidQueue.PendingSnapshot?, now: Long = nowMs()): Panel {
        val steering = droid?.steering.orEmpty().mapIndexed { i, p ->
            Panel.Item("steer:$i:${p.row.text}", DroidQueue.Group.Steering, i, p.row.text, false, p.row.cut || p.row.more > 0, p.row.more)
        }
        val queued = shown(droid?.queued?.map { it.row }, now).mapIndexed { i, s ->
            Panel.Item(s.key, DroidQueue.Group.Queued, i, s.text, s.hasImage, s.preview, s.more)
        }
        return Panel(steering, queued, droid?.moreSteering ?: 0, droid?.moreQueued ?: 0, droid?.reviewActive ?: false)
    }
    companion object {
        /** How long a message sent to the queue shows without Droid's screen showing it: for Droid to draw it, or, once drained, for the conversation to pick it up. */
        const val GRACE_MS = 4_000L
    }
}
