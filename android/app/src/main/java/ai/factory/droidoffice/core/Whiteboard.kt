package ai.factory.droidoffice.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import kotlin.random.Random

// A floor's Whiteboard (src/shared/whiteboard.ts, docs/whiteboard.md), as far as the phone shows and
// changes it: its cards, their comment threads, stickies and pictures, and which of them someone else
// changed since the owner last looked. The phone never replays patches: the reducer lives in the
// office, so a committed change makes it ask for a fresh snapshot instead.

/** The reader id the owner's read points are kept under (OWNER in whiteboard.ts). */
const val WB_OWNER = "owner"

/** The canonical layout width every artifact and its marks use (CANONICAL_WIDTH). */
const val WB_CANONICAL_WIDTH = 1280

@Serializable
data class WbAuthor(val kind: String = "owner", val id: String? = null, val name: String? = null, val color: String? = null) {
    val isOwner: Boolean get() = kind == "owner"
    val reader: String get() = if (isOwner) WB_OWNER else id.orEmpty()
}

@Serializable
data class WbStamp(val rev: Long = 0, val author: WbAuthor = WbAuthor())

@Serializable
data class WbPoint(val x: Double = 0.0, val y: Double = 0.0)

@Serializable
data class WbAnchor(val kind: String = "point", val point: WbPoint = WbPoint(), val wbId: String? = null, val selector: String? = null, val quote: String? = null)

@Serializable
data class WbBox(val x: Double = 0.0, val y: Double = 0.0, val w: Double = 0.0, val h: Double = 0.0)

@Serializable
data class WbMessage(val id: String, val author: WbAuthor = WbAuthor(), val text: String = "", val at: Long = 0, val stamp: WbStamp = WbStamp())

@Serializable
data class WbThreadStamps(val resolved: WbStamp = WbStamp(), val anchor: WbStamp = WbStamp())

@Serializable
data class WbThread(
    val id: String,
    val anchor: WbAnchor = WbAnchor(),
    val detached: Boolean = false,
    val resolved: Boolean = false,
    val messages: List<WbMessage> = emptyList(),
    val stamps: WbThreadStamps = WbThreadStamps(),
)

@Serializable
data class WbSticky(
    val id: String,
    val text: String = "",
    val color: String = "yellow",
    val anchor: WbAnchor = WbAnchor(),
    val box: WbBox = WbBox(),
    val detached: Boolean = false,
    val stamps: Map<String, WbStamp> = emptyMap(),
)

@Serializable
data class WbPicture(
    val id: String,
    val anchor: WbAnchor = WbAnchor(),
    val box: WbBox = WbBox(),
    val detached: Boolean = false,
    val stamps: Map<String, WbStamp> = emptyMap(),
)

@Serializable
data class WbLink(val path: String = "", val dir: Boolean = false, val status: String = "ok", val reason: String? = null)

@Serializable
data class WbContent(val entry: String = "")

@Serializable
data class WbCardStamps(val title: WbStamp = WbStamp(), val content: WbStamp? = null, val state: Map<String, WbStamp> = emptyMap())

@Serializable
data class WbCard(
    val id: String,
    val kind: String = "html",
    val title: String = "",
    val author: WbAuthor = WbAuthor(),
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val content: WbContent? = null,
    val link: WbLink? = null,
    val threads: List<WbThread> = emptyList(),
    val stickies: List<WbSticky> = emptyList(),
    val pictures: List<WbPicture> = emptyList(),
    val stamps: WbCardStamps = WbCardStamps(),
) {
    val isCanvas: Boolean get() = kind == "canvas"
    val openThreads: Int get() = threads.count { !it.resolved }

    /** Every stamped piece's stamp (cardPieces). */
    fun stamps(): Sequence<WbStamp> = sequence {
        yield(stamps.title)
        stamps.content?.let { yield(it) }
        yieldAll(stamps.state.values)
        for (t in threads) {
            yield(t.stamps.resolved)
            yield(t.stamps.anchor)
            for (m in t.messages) yield(m.stamp)
        }
        for (s in stickies) yieldAll(s.stamps.values)
        for (p in pictures) yieldAll(p.stamps.values)
    }
}

@Serializable
data class WbSelection(val kind: String = "grid", val id: String? = null)

@Serializable
data class WbTombstone(val kind: String = "", val id: String = "", val card: String = "", val parent: String? = null, val rev: Long = 0, val author: WbAuthor = WbAuthor(), val at: Long = 0)

@Serializable
data class WbBoard(
    val rev: Long = 0,
    val cards: List<WbCard> = emptyList(),
    val selection: WbSelection = WbSelection(),
    val reads: Map<String, Map<String, Long>> = emptyMap(),
    val tombstones: List<WbTombstone> = emptyList(),
) {
    fun card(id: String): WbCard? = cards.firstOrNull { it.id == id }

    /** Newest first; of two made in the same millisecond, the later one (cardsNewestFirst). */
    fun newestFirst(): List<WbCard> = cards.asReversed().sortedByDescending { it.createdAt }

    fun readPoint(reader: String, card: String): Long = reads[reader]?.get(card) ?: 0

    /** Someone other than [reader] changed it after [since] (isChanged). */
    fun isChanged(stamp: WbStamp, reader: String, since: Long): Boolean = stamp.rev > since && stamp.author.reader != reader

    /** Anything on the card, or a removal from it, the owner hasn't seen (cardChanged). */
    fun changed(cardId: String, reader: String = WB_OWNER): Boolean {
        val since = readPoint(reader, cardId)
        val card = card(cardId)
        if (card != null && card.stamps().any { isChanged(it, reader, since) }) return true
        return tombstones.any { it.card == cardId && it.rev > since && it.author.reader != reader }
    }

    /** A thread with a message, a resolve or a reopen from someone else since the owner last read the card. */
    fun threadChanged(card: WbCard, thread: WbThread, reader: String = WB_OWNER): Boolean = threadChangedSince(thread, readPoint(reader, card.id), reader)

    /** The same against a read point held from before the screen moved it. */
    fun threadChangedSince(thread: WbThread, since: Long, reader: String = WB_OWNER): Boolean =
        isChanged(thread.stamps.resolved, reader, since) || thread.messages.any { isChanged(it.stamp, reader, since) }

    fun changedCards(reader: String = WB_OWNER): Int = cards.count { changed(it.id, reader) }
}

/** A card's latest render, as `whiteboard.rendered` says (WhiteboardRenderInfo). */
@Serializable
data class WbRenderInfo(val rev: Long? = null, val at: Long? = null, val current: Boolean = false, val error: String? = null)

/** Whether cards can be rendered to images at all (WhiteboardRendererStatus). */
@Serializable
data class WbRendererStatus(val available: Boolean = false, val reason: String? = null, val installing: WbInstalling? = null)

@Serializable
data class WbInstalling(val percent: Double? = null, val message: String = "")

/** What `/api/whiteboard/render/status` says about a card's latest image (RenderStatus.image). */
@Serializable
data class WbImageInfo(
    val rev: Long = 0,
    val at: Long = 0,
    val width: Int = WB_CANONICAL_WIDTH,
    val height: Int = 0,
    val tiles: Int = 1,
    val tileHeight: Int = 2048,
    val current: Boolean = false,
    val origin: WbPoint? = null,
    val scale: Double? = null,
) {
    /** The canonical point under a pixel of the image (a canvas's image starts at [origin], at [scale] px per canonical px). */
    fun toCanonical(px: Double, py: Double): WbPoint {
        val s = scale?.takeIf { it > 0 } ?: 1.0
        val o = origin ?: WbPoint()
        return WbPoint(o.x + px / s, o.y + py / s)
    }

    fun toImage(p: WbPoint): WbPoint {
        val s = scale?.takeIf { it > 0 } ?: 1.0
        val o = origin ?: WbPoint()
        return WbPoint((p.x - o.x) * s, (p.y - o.y) * s)
    }
}

@Serializable
data class WbRenderStatus(val available: Boolean = false, val reason: String? = null, val image: WbImageInfo? = null, val error: WbRenderError? = null)

@Serializable
data class WbRenderError(val message: String = "", val at: Long = 0, val rev: Long = 0)

/** The phone's own changes, as the office's Op literals (src/shared/whiteboard.ts `Op`). */
object WbOps {
    private const val ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

    /** A fresh piece id: 1-64 letters, digits, `_` or `-`, starting with a letter or digit (isPieceId). */
    fun newId(prefix: String, random: Random = Random.Default): String = prefix + (1..12).map { ALPHABET[random.nextInt(ALPHABET.length)] }.joinToString("")

    /** A new comment thread pinned at a canonical point. */
    fun commentAdd(card: String, thread: String, message: String, at: WbPoint, text: String): JsonObject = op("comment.add", card) {
        put("thread", thread)
        put("message", message)
        putJsonObject("anchor") {
            put("kind", "point")
            putJsonObject("point") {
                put("x", round(at.x))
                put("y", round(at.y))
            }
        }
        put("text", text)
    }

    fun commentReply(card: String, thread: String, message: String, text: String): JsonObject = op("comment.reply", card) {
        put("thread", thread)
        put("message", message)
        put("text", text)
    }

    fun commentResolve(card: String, thread: String): JsonObject = op("comment.resolve", card) { put("thread", thread) }
    fun commentReopen(card: String, thread: String): JsonObject = op("comment.reopen", card) { put("thread", thread) }

    /** Moves the owner's read point for these cards to a snapshot revision. */
    fun read(cards: List<String>, rev: Long): JsonObject = buildJsonObject {
        put("op", "read")
        putJsonArray("cards") { cards.forEach { add(JsonPrimitive(it)) } }
        put("rev", rev)
    }

    /** What the wall shows: one card, or the grid when [card] is null. */
    fun show(card: String?): JsonObject = buildJsonObject {
        put("op", "show")
        putJsonObject("selection") {
            if (card == null) put("kind", "grid") else {
                put("kind", "card")
                put("id", card)
            }
        }
    }

    private fun round(v: Double): Double = kotlin.math.round(v * 10) / 10

    private inline fun op(name: String, card: String, body: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): JsonObject = buildJsonObject {
        put("op", name)
        put("card", card)
        body()
    }
}

/** How a batch ended (the `ack` and `rejected` updates). */
sealed interface WbResult {
    data class Ok(val rev: Long) : WbResult
    /** It failed validation and changed nothing. */
    data class Invalid(val reason: String) : WbResult
    /** Its epoch is no longer in the office's record, so it was never applied. */
    data object Expired : WbResult
}

/** One floor's board as this phone knows it. */
data class WbFloor(
    val floor: String,
    val board: WbBoard? = null,
    val renderer: WbRendererStatus = WbRendererStatus(),
    val renders: Map<String, WbRenderInfo> = emptyMap(),
    /** Batches the office hasn't acknowledged yet. */
    val pending: Int = 0,
    /** On this floor with a snapshot: committed changes arrive. */
    val live: Boolean = false,
)

/**
 * The phone's side of the floors' Whiteboards (src/client/whiteboard-sync.ts, without the reducer).
 *
 * - A snapshot comes after `welcome`, `floor.enter` and `whiteboard.sync`, with this connection's
 *   epoch for that floor. Every batch is numbered in an epoch and kept until it's acknowledged.
 * - A committed patch makes it ask for a fresh snapshot, one at a time, and only while [watching];
 *   otherwise the board is stale until someone looks.
 * - After a reconnect, every batch not yet acknowledged goes again in the epoch it was numbered in,
 *   so the office applies it once. One whose epoch expired is reported as [WbResult.Expired].
 *
 * Not thread-safe: the connection calls it on the main thread.
 */
class WhiteboardSync(private val send: (String) -> Boolean) {
    private class Pending(var epoch: String, var seq: Int, val ops: List<JsonObject>, val done: (WbResult) -> Unit)

    private class Floor(val id: String) {
        var board: WbBoard? = null
        var epoch: String? = null
        val seqs = HashMap<String, Int>()
        val pending = mutableListOf<Pending>()
        var renderer = WbRendererStatus()
        var renders: Map<String, WbRenderInfo> = emptyMap()
        var live = false
        var syncing = false
        var stale = false
    }

    private val floors = LinkedHashMap<String, Floor>()
    private var up = false
    var current: String? = null
        private set

    /** Something on screen shows the board, so committed patches are fetched as they come. */
    var watching = false
        set(value) {
            field = value
            if (value) floors.values.filter { it.stale && it.live }.forEach(::resync)
        }

    /** Called after anything a screen shows changed. */
    var onChange: () -> Unit = {}

    fun floor(id: String): WbFloor? = floors[id]?.let { f -> WbFloor(f.id, f.board, f.renderer, f.renders, f.pending.size, f.live) }

    fun all(): Map<String, WbFloor> = floors.keys.associateWith { floor(it)!! }

    /** The connection went up or down; up, the welcome and snapshot that follow resend what's pending. */
    fun status(isUp: Boolean) {
        up = isUp
        for (f in floors.values) {
            f.live = false
            f.syncing = false
        }
        onChange()
    }

    /** A new connection arrived on [floor]: each floor gets a new epoch with its next snapshot. */
    fun welcome(floor: String?) {
        for (f in floors.values) {
            f.epoch = null
            f.live = false
            f.syncing = false
        }
        enter(floor)
    }

    /** This connection moved to [floor]; another floor's waiting batches go once its snapshot comes. */
    fun enter(floor: String?) {
        val was = current
        current = floor
        if (was != null && was != floor) floors[was]?.live = false
        for (f in floors.values) if (f.id != floor && f.pending.isNotEmpty()) requestSync(f)
        onChange()
    }

    /** A `whiteboard`, `whiteboard.rendered` or `whiteboard.renderer` message; false for any other. */
    fun handle(t: String, o: JsonObject): Boolean {
        when (t) {
            "whiteboard.renderer" -> {
                val status = o["status"]?.let { runCatching { OfficeJson.decodeFromJsonElement<WbRendererStatus>(it) }.getOrNull() } ?: return true
                floors.values.forEach { it.renderer = status }
                onChange()
            }
            "whiteboard.rendered" -> {
                val f = floorOf(o.str("floor") ?: return true)
                val card = o.str("card") ?: return true
                val info = o["info"]?.let { runCatching { OfficeJson.decodeFromJsonElement<WbRenderInfo>(it) }.getOrNull() } ?: return true
                f.renders = f.renders + (card to info)
                onChange()
            }
            "whiteboard" -> update(floorOf(o.str("floor") ?: return true), o)
            else -> return false
        }
        return true
    }

    /**
     * Sends a batch for the owner, now when the floor is live, else once its snapshot comes. [done]
     * runs once the office has committed it or said why not.
     */
    fun apply(floorId: String, ops: List<JsonObject>, done: (WbResult) -> Unit = {}) {
        if (ops.isEmpty()) return done(WbResult.Ok(floors[floorId]?.board?.rev ?: 0))
        val f = floorOf(floorId)
        val epoch = f.epoch
        if (epoch == null) {
            f.pending += Pending("", 0, ops, done)
            requestSync(f)
        } else {
            val p = Pending(epoch, nextSeq(f, epoch), ops, done)
            f.pending += p
            if (f.live) sendBatch(f, p)
        }
        onChange()
    }

    /** This office is being left: every batch still waiting ends as never applied. */
    fun close() {
        val left = floors.values.flatMap { f -> f.pending.toList().also { f.pending.clear() } }
        floors.clear()
        left.forEach { it.done(WbResult.Expired) }
    }

    /** Asks for a fresh snapshot of a floor now (pull to refresh). */
    fun refresh(floorId: String) = requestSync(floorOf(floorId))

    private fun update(f: Floor, o: JsonObject) {
        val u = o["update"] as? JsonObject ?: return
        when (u.str("kind")) {
            "snapshot" -> {
                val board = u["board"]?.let { runCatching { OfficeJson.decodeFromJsonElement<WbBoard>(it) }.getOrNull() } ?: return
                val epoch = u.str("epoch") ?: return
                f.board = board
                f.epoch = epoch
                (o["renderer"] as? JsonObject)?.let { r -> runCatching { OfficeJson.decodeFromJsonElement<WbRendererStatus>(r) }.getOrNull()?.let { f.renderer = it } }
                f.live = current == f.id
                f.syncing = false
                for (p in f.pending.toList()) {
                    if (p.epoch.isEmpty()) {
                        p.epoch = epoch
                        p.seq = nextSeq(f, epoch)
                    }
                    sendBatch(f, p)
                }
                if (f.stale) {
                    f.stale = false
                    if (watching) resync(f)
                }
            }
            "patch" -> {
                if (!f.live) return
                val rev = ((u["patch"] as? JsonObject)?.get("rev") as? JsonPrimitive)?.longOrNull ?: return
                if (rev <= (f.board?.rev ?: -1)) return
                f.stale = true
                if (watching) resync(f)
            }
            "ack" -> settle(f, u.str("epoch"), u.int("seq"), WbResult.Ok((u["rev"] as? JsonPrimitive)?.longOrNull ?: 0))
            "rejected" -> {
                val r = if (u.str("reason") == "expired") WbResult.Expired
                else WbResult.Invalid((u["error"] as? JsonObject)?.str("reason") ?: "The office refused it")
                settle(f, u.str("epoch"), u.int("seq"), r)
            }
        }
        onChange()
    }

    /** One snapshot at a time: a patch while one is on its way waits for it, then asks again. */
    private fun resync(f: Floor) {
        if (f.syncing) {
            f.stale = true
            return
        }
        f.stale = false
        requestSync(f)
    }

    private fun requestSync(f: Floor) {
        if (!up) return
        if (send(buildJsonObject {
                put("t", "whiteboard.sync")
                put("floor", f.id)
            }.toString())) f.syncing = true
    }

    private fun settle(f: Floor, epoch: String?, seq: Int?, r: WbResult) {
        val i = f.pending.indexOfFirst { it.epoch == epoch && it.seq == seq }
        if (i < 0) return
        f.pending.removeAt(i).done(r)
    }

    private fun nextSeq(f: Floor, epoch: String): Int = ((f.seqs[epoch] ?: 0) + 1).also { f.seqs[epoch] = it }

    private fun sendBatch(f: Floor, p: Pending) {
        send(buildJsonObject {
            put("t", "whiteboard.apply")
            put("floor", f.id)
            putJsonObject("envelope") {
                put("epoch", p.epoch)
                put("seq", p.seq)
                put("ops", JsonArray(p.ops))
            }
        }.toString())
    }

    private fun floorOf(id: String): Floor = floors.getOrPut(id) { Floor(id) }

    private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    private fun JsonObject.int(k: String) = (this[k] as? JsonPrimitive)?.let { it.longOrNull?.toInt() ?: it.contentOrNull?.toDoubleOrNull()?.toInt() }
}

/** Labels and orderings the board screens show. */
object WhiteboardView {
    /** "You" for the owner, else the worker as it was when it acted. */
    fun author(a: WbAuthor): String = if (a.isOwner) "You" else a.name?.ifBlank { null } ?: "A worker"

    /** Who made the card, when it last changed, its link and whether the wall shows it. */
    fun meta(card: WbCard, onWall: Boolean, now: Long): String = listOfNotNull(
        author(card.author),
        Workers.ago(card.updatedAt, now),
        card.link?.let { if (it.status == "ok") "Linked" else "Link broken" },
        "On the wall".takeIf { onWall },
    ).joinToString(" · ")

    /** Open threads first, then resolved ones; each group in the order they were started. */
    fun threads(card: WbCard): List<WbThread> = card.threads.filter { !it.resolved } + card.threads.filter { it.resolved }

    /** A sticky note's paper, as the office draws it. */
    fun stickyColor(name: String): String = when (name) {
        "pink" -> "#ff9fc6"
        "blue" -> "#8fd3ff"
        "green" -> "#a6e3a1"
        "orange" -> "#ffb070"
        "purple" -> "#cdb4ff"
        else -> "#ffd866"
    }
}

/** How the office would take a ping now (src/shared/whiteboard-ping.ts). */
sealed interface PingCheck {
    /** `type`, `resume` or `queue`. */
    data class Ok(val how: String) : PingCheck
    data class No(val reason: String, val busy: Boolean = false) : PingCheck
}

object WhiteboardPing {
    /** What the office does when the owner pings [w] now, or why it can't (pingEligibility). */
    fun eligibility(w: WorkerInfo, now: Long = System.currentTimeMillis()): PingCheck {
        val name = w.name.ifBlank { w.id }
        if (w.isGuest) return PingCheck.No("$name is a guest the office only watches: it has no terminal the office can type into. Bring it in first.")
        if (w.isCloud) return PingCheck.No("$name runs on a Factory computer, which can't reach this office's Whiteboard yet.")
        if (w.isShell) return PingCheck.No("$name is a plain shell, not an agent.")
        if (w.downedUntil != null && w.downedUntil > now) return PingCheck.No("$name is down. Revive it first.")
        if (w.lost != null) return PingCheck.No("$name's worktree is gone, so it can't start. Rebuild it first.")
        return when (w.state) {
            WorkerStatus.Idle, WorkerStatus.Done -> PingCheck.Ok("type")
            WorkerStatus.Exited, WorkerStatus.Offline -> PingCheck.Ok("resume")
            WorkerStatus.Working -> if (w.kind == "agent") PingCheck.Ok("queue") else PingCheck.No("$name is busy and can't queue a message. Ping it when it's free.", busy = true)
            WorkerStatus.Starting -> PingCheck.No("$name is still starting.")
            WorkerStatus.NeedsInput -> PingCheck.No("$name is waiting on an answer in its terminal. Answer it there first.")
            WorkerStatus.Unknown -> PingCheck.No("$name can't be pinged right now.")
        }
    }

    /** What a worker is on, so the owner can pick one without knowing its name: its task, else its first prompt line. */
    fun doing(w: WorkerInfo): String =
        Workers.title(w) ?: w.prompt?.lineSequence()?.map { it.trim() }?.firstOrNull { it.isNotEmpty() } ?: "No task yet"

    /** Pingable workers first, then the busy ones, then the rest; each group by name. */
    fun order(workers: Collection<WorkerInfo>, now: Long = System.currentTimeMillis()): List<Pair<WorkerInfo, PingCheck>> =
        workers.map { it to eligibility(it, now) }
            .sortedWith(compareBy<Pair<WorkerInfo, PingCheck>>({ (_, c) -> if (c is PingCheck.Ok) 0 else if ((c as PingCheck.No).busy) 1 else 2 }, { it.first.name.lowercase() }))

    /** What the office said it did with a ping that went in. */
    fun outcome(name: String, how: String?): String = when (how) {
        "queue" -> "$name will look at the board after its current turn"
        "resume" -> "Woke $name to look at the board"
        else -> "Asked $name to look at the board"
    }
}

/** `whiteboard.pinged`: the line went in, or why it didn't. */
data class WbPinged(val worker: String, val ok: Boolean, val how: String?, val error: String?) {
    companion object {
        fun of(o: JsonObject): WbPinged? {
            val worker = (o["worker"] as? JsonPrimitive)?.contentOrNull ?: return null
            return WbPinged(
                worker,
                (o["ok"] as? JsonPrimitive)?.booleanOrNull ?: false,
                (o["how"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull,
                (o["error"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull,
            )
        }

        fun ping(worker: String): String = buildJsonObject {
            put("t", "whiteboard.ping")
            put("worker", worker)
        }.toString()
    }
}
