package ai.factory.droidoffice.core

/** Client-local acknowledged sends, never inferred pending state from a worker's status. */
class ThreadQueue {
    data class Prompt(val id: Int, val text: String, val hasImage: Boolean, val after: Long)
    private var session: String? = null
    private var serial = 0
    private val consumed = HashSet<String>()
    var sequence: Long = -1
        private set
    var pending: List<Prompt> = emptyList()
        private set

    fun sent(text: String, hasImage: Boolean, after: Long = sequence) {
        pending = pending + Prompt(++serial, text, hasImage, after)
    }

    fun sync(sessionId: String?, entries: List<ThreadEntry>): List<Prompt> {
        if (sessionId != null && session != null && sessionId != session) {
            pending = emptyList()
            consumed.clear()
            sequence = -1
        }
        if (sessionId != null) session = sessionId
        for (entry in entries) sequence = maxOf(sequence, entry.seq)
        pending = pending.filter { item ->
            val match = entries.firstOrNull { entry ->
                entry.role == ThreadRole.User && entry.seq > item.after && entry.id !in consumed &&
                    if (item.text.isNotEmpty()) entry.kind == ThreadKind.Text && entry.text?.trim() == item.text
                    else item.hasImage && entry.kind == ThreadKind.Notice && entry.text == "[Image attachment]"
            }
            if (match == null) true else {
                consumed += match.id
                false
            }
        }
        if (pending.isEmpty()) consumed.clear()
        return pending
    }
}
