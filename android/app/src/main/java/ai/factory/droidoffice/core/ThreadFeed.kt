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
 * result in [output] once there is one; [resultSeq] is the seq the next entry took when that result
 * was read, so a result that only came after later entries can be told apart.
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
    val resultSeq: Long? = null,
) {
    companion object {
        /** An entry with no id, no seq, or a role or kind this app doesn't know is skipped rather than guessed at. */
        fun of(e: JsonElement): ThreadEntry? {
            val o = e as? JsonObject ?: return null
            val id = o.str("id")?.takeIf { it.isNotEmpty() } ?: return null
            val seq = o.long("seq") ?: return null
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
                resultSeq = o.long("resultSeq"),
            )
        }

        private fun JsonObject.long(k: String) = (this[k] as? JsonPrimitive)?.let { it.longOrNull ?: it.contentOrNull?.toDoubleOrNull()?.toLong() }

        private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content
    }
}

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
    /** How the office presents [entries], oldest first: never built here, only joined from its pages. */
    val rows: List<ThreadRow> = emptyList(),
    /** Whether the last page's presentation could be read. When it couldn't, [rows] has nothing from it. */
    val support: ThreadSupport = ThreadSupport.Supported,
    /** There are entries before the first one here. */
    val hasMore: Boolean = false,
    /** The office's last error for the latest page, shown over what is already here. */
    val error: String? = null,
    val loadingEarlier: Boolean = false,
    val earlierError: String? = null,
    /**
     * Earlier pages pushed the newest entries out of the [ThreadFeed.MAX_ENTRIES] window: the list
     * stops following, and [ThreadFeed.backToLatest] loads the newest page again.
     */
    val newerTrimmed: Boolean = false,
)

/**
 * A worker's thread for one screen: which `thread.read` requests are out, and what their answers add
 * up to. Every request id carries this feed's own random prefix, so an answer meant for another
 * worker, floor, connection or an earlier visit never lands here. Only the newest latest-page request
 * and the one earlier-page request are accepted; anything else is stale and ignored.
 *
 * The latest page is the truth from its first entry on: it replaces whatever was loaded from that
 * seq onward, so an entry the session rewound or rewrote is dropped, while older pages before it stay.
 * When its first entry isn't the one loaded at that seq (a rewrite reaching back past the page, or a
 * gap of more than a page), it replaces everything, as does a new session, a page with no more before
 * it, or an empty one. At most [MAX_ENTRIES] stay loaded: the oldest go as new ones arrive (Load
 * earlier fetches them again), and the newest go when an earlier page needs the room.
 *
 * The rows come from the office and are joined the way the web companion joins them
 * (src/client/thread-history.ts): a latest page's rows replace every held row that ends at or after
 * its first row or entry, keeping the part of an Activity whose entries are still loaded as a clipped
 * prefix, and an earlier page adds its rows and Activity prefixes before the first one held.
 * Whatever clears the entries clears the rows, and trimming the entries drops the rows wholly outside
 * them. A page from an office with no presentation, or one of a version this app doesn't know, adds no
 * rows and sets [ThreadState.support].
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

    /** Leaves older history for the newest page, after earlier pages pushed it out. */
    fun backToLatest() {
        latest = null
        earlier = null
        state = state.copy(phase = ThreadPhase.Loading, entries = emptyList(), rows = emptyList(), hasMore = false, error = null, loadingEarlier = false, earlierError = null, newerTrimmed = false)
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
            val before = earlier?.before
            earlier = null
            state = when {
                msg.error != null -> state.copy(loadingEarlier = false, earlierError = msg.error)
                // The session moved on, or the list's first entry changed, while this page was out: it
                // no longer joins onto what is shown.
                msg.sessionId != state.sessionId || state.entries.firstOrNull()?.seq != before -> state.copy(loadingEarlier = false)
                else -> older(msg, before ?: Long.MAX_VALUE)
            }
            return true
        }
        latest = null
        if (msg.error != null) {
            state = state.copy(phase = if (state.entries.isEmpty()) ThreadPhase.Error else ThreadPhase.Ready, error = msg.error)
            return true
        }
        val page = msg.entries.sortedBy { it.seq }.distinctBy { it.id }
        val support = ThreadSupport.of(msg.presentation)
        val incoming = incoming(msg, support)
        val newSession = msg.sessionId != state.sessionId && (state.sessionId != null || state.entries.isNotEmpty())
        val base = if (newSession) emptyList() else state.entries
        val first = page.firstOrNull()
        val anchored = first != null && base.any { it.id == first.id && it.seq == first.seq }
        val rewritten = page.any { e -> base.any { it.seq == e.seq && it.id != e.id } }
        if (state.newerTrimmed && !newSession && page.isNotEmpty() && !rewritten) {
            // Reading older history: keep the window where it is and only update what's in it.
            val byId = page.associateBy { it.id }
            val rowsById = incoming.associateBy { it.id }
            state = state.copy(phase = ThreadPhase.Ready, entries = base.map { byId[it.id] ?: it }, rows = state.rows.map { rowsById[it.id] ?: it }, support = support, error = null)
            return true
        }
        val (entries, hasMore, reset) = when {
            page.isEmpty() -> Triple(emptyList(), msg.hasMore, true)
            !msg.hasMore -> Triple(page, false, true)
            base.isEmpty() -> Triple(page, true, newSession)
            anchored -> page.first().let { f -> Triple(base.filter { it.seq < f.seq } + page, f.seq <= base.first().seq || state.hasMore, false) }
            else -> Triple(page, true, true)
        }
        val kept = if (entries.size > MAX_ENTRIES) entries.takeLast(MAX_ENTRIES) else entries
        val held = if (reset || base.isEmpty()) emptyList() else state.rows
        val cut = minOf(incoming.firstOrNull()?.from ?: Long.MAX_VALUE, page.firstOrNull()?.seq ?: Long.MAX_VALUE)
        val rows = if (page.isEmpty()) emptyList() else rowsBefore(held, cut, kept) + incoming
        if (reset || kept.size < entries.size) earlier = null
        state = state.copy(
            phase = ThreadPhase.Ready,
            sessionId = msg.sessionId,
            entries = kept,
            rows = if (kept.size < entries.size) within(rows, kept) else rows,
            support = support,
            hasMore = hasMore || kept.size < entries.size,
            error = null,
            loadingEarlier = if (reset || kept.size < entries.size) false else state.loadingEarlier,
            earlierError = if (reset) null else state.earlierError,
            newerTrimmed = false,
        )
        return true
    }

    /** An earlier page joined in front of what's loaded; past [MAX_ENTRIES], the newest entries make room. */
    private fun older(msg: ServerMsg.ThreadSnapshot, before: Long): ThreadState {
        val loaded = state.entries.mapTo(HashSet()) { it.id }
        val page = msg.entries.filter { it.seq < before && it.id !in loaded }.sortedBy { it.seq }.distinctBy { it.id }
        val all = page + state.entries
        val kept = if (all.size > MAX_ENTRIES) all.take(MAX_ENTRIES) else all
        val support = ThreadSupport.of(msg.presentation)
        val heldFrom = state.rows.firstOrNull()?.from ?: Long.MAX_VALUE
        val rows = rowsBefore(incoming(msg, support), heldFrom, kept) + state.rows
        return state.copy(
            entries = kept,
            rows = if (kept.size < all.size) within(rows, kept) else rows,
            support = support,
            hasMore = msg.hasMore,
            loadingEarlier = false,
            earlierError = null,
            newerTrimmed = state.newerTrimmed || kept.size < all.size,
        )
    }

    private fun incoming(msg: ServerMsg.ThreadSnapshot, support: ThreadSupport) =
        if (support == ThreadSupport.Supported) msg.presentation?.rows.orEmpty() else emptyList()

    /**
     * The rows that end before [cut], and the loaded prefix of an Activity that crosses it. Used for
     * held rows when the office's read window slides forward, and incoming rows when an earlier page
     * overlaps the first row held. Its summary is rebuilt from the actions it holds: the office's
     * label, status and state describe the whole run, which the row after the cut carries now.
     */
    private fun rowsBefore(held: List<ThreadRow>, cut: Long, entries: List<ThreadEntry>): List<ThreadRow> {
        val seq = entries.associate { it.id to it.seq }
        fun held(id: String) = (seq[id] ?: Long.MAX_VALUE) <= cut - 1
        val rows = mutableListOf<ThreadRow>()
        for (row in held) {
            if (row.to < cut) {
                rows += row
                continue
            }
            if (row !is ThreadRow.Activity || row.from >= cut) continue
            val sourceIds = row.sourceIds.filter(::held)
            val blocks = row.blocks.mapNotNull { block ->
                when (block) {
                    is ThreadBlock.Thought -> block.takeIf { held(block.id) }
                    is ThreadBlock.Tools -> block.actions.filter { held(it.id) }.takeIf { it.isNotEmpty() }?.let { block.copy(actions = it) }
                }
            }
            if (sourceIds.isEmpty() || blocks.isEmpty()) continue
            val actions = blocks.flatMap { if (it is ThreadBlock.Tools) it.actions else emptyList() }
            fun count(state: ActivityState) = actions.count { it.state == state && it.causedBy == null }
            val state = when {
                count(ActivityState.Failed) > 0 -> ActivityState.Failed
                count(ActivityState.Incomplete) > 0 -> ActivityState.Incomplete
                count(ActivityState.Cancelled) > 0 -> ActivityState.Cancelled
                else -> ActivityState.Complete
            }
            rows += row.copy(
                to = cut - 1,
                sourceIds = sourceIds,
                label = "Earlier activity",
                state = state,
                live = false,
                status = null,
                running = null,
                failed = row.failed.filter { held(it.id) },
                blocks = blocks,
            )
        }
        return rows
    }
    /** The rows that stand for any of [entries]' seq range. */
    private fun within(rows: List<ThreadRow>, entries: List<ThreadEntry>): List<ThreadRow> {
        val from = entries.firstOrNull()?.seq ?: return emptyList()
        val to = entries.last().seq
        return rows.filter { it.to >= from && it.from <= to }
    }

    companion object {
        /** The most entries kept loaded: twenty pages. */
        const val MAX_ENTRIES = 2_000
        /** A latest-page request unanswered this long is asked again. */
        const val RESEND_MS = 5_000L
        /** No answer at all for this long means the office can't show threads. */
        const val UNAVAILABLE_MS = 6_000L
    }
}
