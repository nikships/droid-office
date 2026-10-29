package ai.factory.droidoffice.rn

import ai.factory.droidoffice.core.HoldTokens
import ai.factory.droidoffice.core.HostLinkState
import ai.factory.droidoffice.core.HostLog
import ai.factory.droidoffice.core.ImageOrigins
import ai.factory.droidoffice.core.OfficeEndpoint
import ai.factory.droidoffice.core.OfficeJson
import ai.factory.droidoffice.core.OwnedHolds
import ai.factory.droidoffice.core.Routes
import ai.factory.droidoffice.core.UploadTarget
import ai.factory.droidoffice.data.OfficeStore
import ai.factory.droidoffice.data.StoreSnapshot
import ai.factory.droidoffice.data.displayName
import ai.factory.droidoffice.net.OfficeApi
import ai.factory.droidoffice.net.OfficeAuth
import ai.factory.droidoffice.session.OfficeConnection
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/** A notification tap or link for the React Native side (src/mobile/host.ts HostIncoming). */
sealed interface HostIncoming {
    val office: String

    data class Worker(override val office: String, val worker: String, val floor: String? = null) : HostIncoming
    data class Floor(override val office: String, val floor: String) : HostIncoming

    fun json(): JsonObject = buildJsonObject {
        when (val i = this@HostIncoming) {
            is Worker -> {
                put("kind", "worker")
                put("office", i.office)
                put("worker", i.worker)
                i.floor?.let { put("floor", it) }
            }
            is Floor -> {
                put("kind", "floor")
                put("office", i.office)
                put("floor", i.floor)
            }
        }
    }
}

/**
 * The React Native side's view of the app's connection, for the life of the process: the order of
 * events ([HostLog]), its own worker holds, requests waiting on a receipt, pictures uploaded for
 * prompts not sent yet, and a link that arrived before the page could hear it. [HostModule] is its
 * face to JavaScript and can come and go (a reload) while this stays. Main thread only, except
 * [send], [screen], [tokens] and [images]: synchronous JavaScript calls touch only synchronized
 * hold/image ownership, the connection's volatile socket state and StateFlows.
 */
class NativeHost(val scope: CoroutineScope, val connection: OfficeConnection, val store: OfficeStore, val api: OfficeApi) {
    private val main = Handler(Looper.getMainLooper())

    /** Where events go: the live module's emitter, or nowhere while JavaScript isn't running. */
    private var emitter: ((String) -> Unit)? = null

    /** Whether the live page has asked for its bootstrap, after which links go to it as events. */
    private var booted = false

    /** A link from before the page bootstrapped, handed over once by [bootstrap]. */
    private var pending: HostIncoming? = null

    val tokens = HoldTokens(connection.sharedHolds)

    /** The page's own `worker.attach`/`detach` sends, counted apart from every other view's. */
    val raw = OwnedHolds(connection.sharedHolds)

    /** Pictures uploaded for prompts not sent yet, with the office and route each went to. */
    val images = ImageOrigins<OfficeEndpoint<OfficeAuth>>()

    private class Waiting(val epoch: Long, val images: List<String>, val done: (String) -> Unit)

    private val waiting = LinkedHashMap<String, Waiting>()
    private var requestCounter = 0L
    private val screenPosts = HashSet<String>()

    init {
        connection.listenLog(::onLog)
        scope.launch {
            store.snapshot.filter { it.loaded }.map(::offices).distinctUntilChanged().collect { o ->
                emit(buildJsonObject {
                    put("k", "offices")
                    put("offices", o.withSeq(connection.log.next()))
                })
            }
        }
        scope.launch {
            // An office forgotten here can't be reached: its pictures go with it.
            store.snapshot.filter { it.loaded }.map { s -> s.offices.map { it.id }.toSet() }.distinctUntilChanged().collect(images::keep)
        }
    }

    /** A module started: events go to [emit] until [detach]. Its page has yet to bootstrap. */
    fun attach(emit: (String) -> Unit) {
        if (emitter === emit) return
        emitter = emit
        unbooted()
    }

    /** The page asked for its bootstrap, perhaps before the module's own start reached the main thread. */
    fun attachIfNeeded(emit: (String) -> Unit) = attach(emit)

    fun detach(emit: (String) -> Unit) {
        if (emitter !== emit) return
        emitter = null
        unbooted()
    }

    private fun emit(e: JsonObject) = emitter?.invoke(e.toString())

    /** From MainActivity: a worker or floor to open. Queued until the page has bootstrapped, then sent once. */
    fun incoming(i: HostIncoming) {
        if (emitter == null || !booted) {
            pending = i
            return
        }
        emit(buildJsonObject {
            put("k", "incoming")
            put("incoming", i.json())
        })
    }

    /** Everything the page needs to start, read at one seq. */
    fun bootstrap(): String {
        val log = connection.log
        val replay = buildJsonArray {
            for (text in log.replay.snapshot()) runCatching { OfficeJson.parseToJsonElement(text) }.getOrNull()?.let { add(it) }
        }
        val incoming = pending
        pending = null
        booted = emitter != null
        val o = offices(store.snapshot.value)
        return buildJsonObject {
            put("offices", o.list)
            o.active?.let { put("active", it) }
            put("link", linkJson(log.link, log.linkSeq))
            put("seq", log.seq)
            put("replay", replay)
            incoming?.let { put("incoming", it.json()) }
        }.toString()
    }

    /** The page went away (a reload, the activity gone): what it held and waited on goes with it. */
    private fun unbooted() {
        booted = false
        raw.release()
        tokens.releaseAll()
        val gone = waiting.values.toList()
        waiting.clear()
        gone.forEach { it.done(uncertain("The app restarted before the office answered.")) }
    }

    private fun onLog(e: HostLog.Event) {
        when (e) {
            is HostLog.Event.Link -> {
                emit(buildJsonObject {
                    put("k", "link")
                    put("link", linkJson(e.link, e.seq))
                })
                if (e.link.phase != HostLinkState.CONNECTED) dropWaiting(null)
            }
            is HostLog.Event.Message -> {
                val f = e.frame
                if (f.t == "welcome") dropWaiting(e.epoch)
                when {
                    f.t == "screen" -> f.workerId?.let(::screenChanged)
                    // Terminals are native views with feeds of their own.
                    f.t.startsWith("term.") -> Unit
                    else -> emitter?.invoke("{\"k\":\"message\",\"seq\":${e.seq},\"epoch\":${e.epoch},\"msg\":${f.text}}")
                }
                if (f.t == "action.result") receipt(f.text)
            }
        }
    }

    /** Throttled: the page reads the rows with [screen] when it wants them. */
    private fun screenChanged(workerId: String) {
        if (!screenPosts.add(workerId)) return
        main.postDelayed({
            screenPosts.remove(workerId)
            emit(buildJsonObject {
                put("k", "screen")
                put("workerId", workerId)
            })
        }, SCREEN_THROTTLE_MS)
    }

    fun screen(workerId: String): String? {
        val epoch = connection.liveEpoch ?: return null
        val s = connection.screens.value[workerId] ?: return null
        if (connection.liveEpoch != epoch) return null
        return JsonArray(s.lines.map { row -> JsonPrimitive(row.joinToString("") { it.text }.trimEnd()) }).toString()
    }

    /** Sends a ClientMsg the page wrote. Its attaches are holds of its own. Never queued. */
    fun send(json: String): Boolean {
        val msg = parse(json) ?: return false
        if (connection.liveEpoch == null) return false
        return when (val t = msg.str("t")) {
            null -> false
            "worker.attach", "worker.detach" -> {
                val id = msg.str("workerId")?.takeIf { ID.matches(it) } ?: return false
                if (t == "worker.attach") raw.attach(id) else raw.detach(id)
                true
            }
            else -> connection.send(json).also { if (it) images.sent(imagesOf(msg)) }
        }
    }

    /**
     * Sends with a receipt: answers with the office's action.result, or ok:false (uncertain, never
     * resent) when the socket drops or [REQUEST_TIMEOUT_MS] passes.
     */
    fun request(json: String, done: (String) -> Unit) {
        val msg = parse(json)
        val epoch = connection.liveEpoch
        if (msg?.str("t") == null) return done(failed("The app could not read that action."))
        if (epoch == null) return done(failed("Disconnected. Nothing was sent."))
        val id = "n${++requestCounter}-${System.currentTimeMillis().toString(36)}"
        val out = JsonObject(msg + ("requestId" to JsonPrimitive(id)))
        waiting[id] = Waiting(epoch, imagesOf(msg), done)
        if (!connection.send(out.toString())) {
            waiting.remove(id)
            return done(failed("Disconnected. Nothing was sent."))
        }
        main.postDelayed({ waiting.remove(id)?.done?.invoke(uncertain("The office didn't answer in time.")) }, REQUEST_TIMEOUT_MS)
    }

    private fun receipt(text: String) {
        val o = parse(text) ?: return
        val w = waiting.remove(o.str("requestId") ?: return) ?: return
        val ok = (o["ok"] as? JsonPrimitive)?.booleanOrNull == true
        if (ok) images.sent(w.images)
        w.done(buildJsonObject {
            put("ok", ok)
            o.str("error")?.let { put("error", it) }
            o.str("workerId")?.let { put("workerId", it) }
        }.toString())
    }

    /** Requests of every socket but [keep] can no longer be answered. */
    private fun dropWaiting(keep: Long?) {
        val gone = waiting.entries.filter { it.value.epoch != keep }.map { it.key to it.value }
        gone.forEach { waiting.remove(it.first) }
        gone.forEach { it.second.done(uncertain("The connection dropped before the office answered.")) }
    }

    /** The active office and its live socket's route, for an upload; null while down. */
    fun uploadTarget(floor: String): UploadTarget<OfficeEndpoint<OfficeAuth>>? {
        val epoch = connection.liveEpoch ?: return null
        val office = connection.log.link.office ?: return null
        if (connection.log.replay.floorId() != floor) return null
        return connection.bound(office, epoch)?.let { UploadTarget(office, floor, epoch, it) }
    }

    fun current(target: UploadTarget<OfficeEndpoint<OfficeAuth>>): Boolean = target.matches(
        store.snapshot.value.active?.id,
        connection.log.replay.floorId(),
        connection.liveEpoch,
        connection.bound(target.office, target.epoch),
    )

    /** Remembers where an upload went; the oldest past the limit are deleted where they went. */
    fun recordImage(id: String, office: String, floor: String, route: OfficeEndpoint<OfficeAuth>) {
        for ((old, o) in images.record(id, office, floor, route)) scope.launch { api.unstageImage(o.route.base, o.route.auth, o.floor, old) }
    }

    /** Deletes an unsent picture on the office it went to, and nowhere else. */
    fun forgetImage(floor: String, id: String, office: String?) {
        val origin = images.forget(id, floor, office) ?: return
        scope.launch { api.unstageImage(origin.route.base, origin.route.auth, floor, id) }
    }

    private data class Offices(val list: JsonArray, val active: String?) {
        fun withSeq(seq: Long) = buildJsonObject {
            put("offices", list)
            active?.let { put("active", it) }
            put("seq", seq)
        }
    }

    private fun offices(s: StoreSnapshot) = Offices(
        JsonArray(
            s.offices.map { o ->
                buildJsonObject {
                    put("id", o.id)
                    put("name", o.displayName)
                    // How the phone last reached it, never where.
                    val how = o.lastBase?.let { Routes.kindOf(it).label }
                    listOfNotNull(o.project, how).joinToString(" · ").takeIf { it.isNotEmpty() }?.let { put("where", it) }
                }
            },
        ),
        s.active?.id,
    )

    companion object {
        const val REQUEST_TIMEOUT_MS = 60_000L
        const val SCREEN_THROTTLE_MS = 250L
        val ID = Regex("^[A-Za-z0-9_\\-:.]{1,64}$")

        private fun linkJson(l: HostLinkState, seq: Long) = buildJsonObject {
            put("phase", l.phase)
            put("epoch", l.epoch)
            put("seq", seq)
            l.office?.let { put("office", it) }
            l.reason?.let { put("reason", it) }
        }

        private fun parse(text: String) = runCatching { OfficeJson.parseToJsonElement(text) as? JsonObject }.getOrNull()

        private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

        private fun imagesOf(msg: JsonObject): List<String> = (msg["images"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }.orEmpty()

        fun failed(error: String) = buildJsonObject {
            put("ok", false)
            put("error", error)
        }.toString()

        private fun uncertain(why: String) = failed("$why Check its current state before trying again; it was not resent.")
    }
}
