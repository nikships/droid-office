package ai.factory.droidoffice.core

import kotlinx.serialization.Serializable

/** Client-local acknowledged sends, never inferred pending state from a worker's status. */
class ThreadQueue(saved: String? = null) {
    @Serializable
    data class Prompt(val id: Int, val text: String, val hasImage: Boolean, val after: Long)
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

    fun sent(text: String, hasImage: Boolean, after: Long = sequence) {
        pending = (pending + Prompt(++serial, text, hasImage, after)).takeLast(32)
    }

    /** Dismisses receipts in this client, never changes Droid's queue. */
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
                    // Observed Droid queue drain: consecutive text sends concatenate without a separator.
                    joined += item.text
                    val match = if (item.text.isNotEmpty()) entry.kind == ThreadKind.Text && entry.text?.trim() == joined
                    else start == end && item.hasImage && entry.kind == ThreadKind.Notice && entry.text == "[Image attachment]"
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
}
