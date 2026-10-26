package ai.factory.droidoffice.core

import java.util.UUID
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

enum class ThreadRole(val wire: String) {
    User("user"),
    Assistant("assistant"),
    System("system");

    companion object {
        fun of(wire: String?): ThreadRole? = entries.firstOrNull { it.wire == wire }
    }
}

enum class ThreadKind(val wire: String) {
    Text("text"),
    Tool("tool"),
    Thinking("thinking"),
    Notice("notice"),
    Todo("todo");

    companion object {
        fun of(wire: String?): ThreadKind? = entries.firstOrNull { it.wire == wire }
    }
}

/**
 * One entry of a worker's conversation as the office reads it from the Droid session (`ThreadEntry`
 * in src/shared/protocol.ts). A tool call carries its arguments as pretty JSON in [input] and its
 * result in [output] once there is one.
 */
data class ThreadEntry(
    val id: String,
    val seq: Long,
    val role: ThreadRole,
    val kind: ThreadKind,
    val text: String? = null,
    val name: String? = null,
    val input: String? = null,
    val output: String? = null,
    val error: Boolean = false,
) {
    companion object {
        /** An entry with no id, no seq, or a role or kind this app doesn't know is skipped rather than guessed at. */
        fun of(e: JsonElement): ThreadEntry? {
            val o = e as? JsonObject ?: return null
            val id = o.str("id")?.takeIf { it.isNotEmpty() } ?: return null
            val seq = (o["seq"] as? JsonPrimitive)?.let { it.longOrNull ?: it.contentOrNull?.toDoubleOrNull()?.toLong() } ?: return null
            val role = ThreadRole.of(o.str("role")) ?: return null
            val kind = ThreadKind.of(o.str("kind")) ?: return null
            return ThreadEntry(
                id = id,
                seq = seq,
                role = role,
                kind = kind,
                text = o.str("text"),
                name = o.str("name"),
                input = o.str("input"),
                output = o.str("output"),
                error = (o["error"] as? JsonPrimitive)?.booleanOrNull ?: false,
            )
        }

        private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content
    }
}

/** Where a tool call stands, as far as the transcript shows. */
enum class ToolState { Running, Done, Failed, NoResult }

enum class ThreadPhase {
    /** Asked, and nothing has come back yet. */
    Loading,
    Ready,
    /** The office answered with an error and there is nothing to show. */
    Error,
    /** The office never answered: one from before threads, or it can't read this worker's session. */
    Unavailable,
}

data class ThreadState(
    val phase: ThreadPhase = ThreadPhase.Loading,
    val sessionId: String? = null,
    /** Oldest first, by seq. */
    val entries: List<ThreadEntry> = emptyList(),
    /** There are entries before the first one here. */
    val hasMore: Boolean = false,
    /** The office's last error for the latest page, shown over what is already here. */
    val error: String? = null,
    val loadingEarlier: Boolean = false,
    val earlierError: String? = null,
)

/**
 * A worker's thread for one screen: which `thread.read` requests are out, and what their answers add
 * up to. Every request id carries this feed's own random prefix, so an answer meant for another
 * worker, floor, connection or an earlier visit never lands here. Only the newest latest-page request
 * and the one earlier-page request are accepted; anything else is stale and ignored.
 *
 * The latest page is merged by entry id into what is loaded, so older pages stay. A new session
 * clears everything. A full latest page with no overlap after a long gap replaces what was here, so
 * the list never shows a hole.
 */
class ThreadFeed(val workerId: String, private val prefix: String = UUID.randomUUID().toString().take(8)) {
    var state = ThreadState()
        private set

    private data class Pending(val request: String, val at: Long, val before: Long? = null)

    private var count = 0
    private var latest: Pending? = null
    private var earlier: Pending? = null
    private var askedSince: Long? = null
    private var answered = false

    private fun nextId() = "$prefix-${++count}"

    /** A new request for the latest page, or null while one is still out, or once the office has shown it can't answer. */
    fun latest(now: Long): String? {
        if (state.phase == ThreadPhase.Unavailable) return null
        latest?.let { if (now - it.at < RESEND_MS) return null }
        val id = nextId()
        latest = Pending(id, now)
        if (askedSince == null) askedSince = now
        return id
    }

    /** The request and `before` for the page before the first entry here, or null when there is none to ask for. */
    fun earlier(now: Long): Pair<String, Long>? {
        val first = state.entries.firstOrNull() ?: return null
        if (!state.hasMore || earlier != null || state.phase != ThreadPhase.Ready) return null
        val id = nextId()
        earlier = Pending(id, now, first.seq)
        state = state.copy(loadingEarlier = true, earlierError = null)
        return id to first.seq
    }

    /** The request [id] never left the phone (the socket was down): forget it. */
    fun unsent(id: String) {
        if (latest?.request == id) latest = null
        if (earlier?.request == id) {
            earlier = null
            state = state.copy(loadingEarlier = false, earlierError = "Couldn't reach the office.")
        }
    }

    /** Times requests out. True when [state] changed. */
    fun tick(now: Long): Boolean {
        val before = state
        val since = askedSince
        if (!answered && since != null && now - since >= UNAVAILABLE_MS && state.phase == ThreadPhase.Loading) {
            state = state.copy(phase = ThreadPhase.Unavailable)
            latest = null
        }
        earlier?.let {
            if (now - it.at >= RESEND_MS) {
                earlier = null
                state = state.copy(loadingEarlier = false, earlierError = "The office didn't send the earlier messages.")
            }
        }
        return state != before
    }

    /** The connection went down: whatever was asked on it won't be answered. What's loaded stays. */
    fun disconnected() {
        latest = null
        askedSince = null
        if (earlier != null) {
            earlier = null
            state = state.copy(loadingEarlier = false)
        }
    }

    /** Ask again after an error or no answer. */
    fun retry() {
        latest = null
        askedSince = null
        state = state.copy(
            phase = if (state.entries.isEmpty()) ThreadPhase.Loading else ThreadPhase.Ready,
            error = null,
            earlierError = null,
        )
    }

    /** Applies an answer when it is to a request still out from this feed. True when it was. */
    fun receive(msg: ServerMsg.ThreadSnapshot): Boolean {
        if (msg.workerId != workerId) return false
        val isLatest = msg.before == null && latest?.request == msg.request
        val isEarlier = earlier?.let { it.request == msg.request && it.before == msg.before } == true
        if (!isLatest && !isEarlier) return false
        answered = true
        if (isEarlier) {
            earlier = null
            state = when {
                msg.error != null -> state.copy(loadingEarlier = false, earlierError = msg.error)
                // The session moved on while this page was out: it belongs to a thread no longer shown.
                msg.sessionId != state.sessionId -> state.copy(loadingEarlier = false)
                else -> state.copy(entries = merge(state.entries, msg.entries), hasMore = msg.hasMore, loadingEarlier = false, earlierError = null)
            }
            return true
        }
        latest = null
        if (msg.error != null) {
            state = state.copy(phase = if (state.entries.isEmpty()) ThreadPhase.Error else ThreadPhase.Ready, error = msg.error)
            return true
        }
        val newSession = msg.sessionId != state.sessionId && (state.sessionId != null || state.entries.isNotEmpty())
        if (newSession) earlier = null
        var base = if (newSession) emptyList() else state.entries
        val page = msg.entries.sortedBy { it.seq }
        val gap = base.isNotEmpty() && msg.hasMore && page.isNotEmpty() && page.first().seq > base.last().seq && page.none { e -> base.any { it.id == e.id } }
        if (gap) base = emptyList()
        val hasMore = when {
            base.isEmpty() -> msg.hasMore
            page.isNotEmpty() && page.first().seq <= base.first().seq -> msg.hasMore
            else -> state.hasMore
        }
        state = state.copy(
            phase = ThreadPhase.Ready,
            sessionId = msg.sessionId,
            entries = merge(base, page),
            hasMore = hasMore,
            error = null,
            loadingEarlier = if (newSession || gap) false else state.loadingEarlier,
            earlierError = if (newSession || gap) null else state.earlierError,
        )
        if (gap) earlier = null
        return true
    }

    companion object {
        /** A latest-page request unanswered this long is asked again. */
        const val RESEND_MS = 5_000L
        /** No answer at all for this long means the office can't show threads. */
        const val UNAVAILABLE_MS = 6_000L

        fun merge(base: List<ThreadEntry>, page: List<ThreadEntry>): List<ThreadEntry> {
            if (page.isEmpty()) return base
            val byId = LinkedHashMap<String, ThreadEntry>(base.size + page.size)
            for (e in base) byId[e.id] = e
            for (e in page) byId[e.id] = e
            return byId.values.sortedBy { it.seq }
        }

        /** A tool call with no result yet is running while the worker is in a turn, and never got one otherwise. */
        fun toolState(e: ThreadEntry, busy: Boolean): ToolState = when {
            e.error -> ToolState.Failed
            e.output != null -> ToolState.Done
            busy -> ToolState.Running
            else -> ToolState.NoResult
        }

        /** A one-line summary of a tool call's arguments: the first short string value, else nothing. */
        fun toolSummary(input: String?, max: Int = 80): String? {
            val raw = input?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            val obj = runCatching { OfficeJson.parseToJsonElement(raw) as? JsonObject }.getOrNull()
            val value = obj?.let { o ->
                PREFERRED.firstNotNullOfOrNull { k -> (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content }
                    ?: o.values.firstNotNullOfOrNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
            } ?: if (obj == null) raw else null
            val line = value?.lineSequence()?.firstOrNull { it.isNotBlank() }?.trim() ?: return null
            return if (line.length <= max) line else line.take(max - 1).trimEnd() + "…"
        }

        private val PREFERRED = listOf("command", "file_path", "path", "pattern", "url", "query", "description", "prompt")
    }
}
