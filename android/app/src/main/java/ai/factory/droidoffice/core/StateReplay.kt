package ai.factory.droidoffice.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** One frame from the office's socket: its raw JSON text and what [StateReplay] needs of it. */
class Frame(val t: String, val text: String, val workerId: String? = null, val floor: String? = null) {
    companion object {
        /** A frame from the socket's text, or null when it isn't a JSON object with a string `t`. */
        fun parse(text: String): Frame? {
            val o = runCatching { OfficeJson.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return null
            val t = o.str("t") ?: return null
            val worker = when (t) {
                "worker.update" -> (o["worker"] as? JsonObject)?.str("id")
                "worker.remove" -> o.str("workerId")
                else -> null
            }
            val floor = if (t == "welcome" || t == "floor.enter") o.str("floor") else null
            return Frame(t, text, worker, floor)
        }

        private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    }
}

/**
 * What a page that joins an already open socket needs to catch up, kept as the socket's own frames:
 * src/shared/companion-replay.ts, which the office's tests pin, in Kotlin. Applied in order to an empty
 * store, [snapshot] leaves it as the live frames did. Kept: the last `welcome`, the `floor.enter` after
 * it, the latest of each state broadcast, and worker updates folded per worker. Not kept: terminal
 * frames, toasts, answers to someone's request, and the Whiteboard.
 */
class StateReplay {
    private var welcome: Frame? = null
    private var enter: Frame? = null
    private val office = LinkedHashMap<String, Frame>()
    private val floor = LinkedHashMap<String, Frame>()
    private val workers = LinkedHashMap<String, Frame>()

    /** Every frame from the socket, in order. */
    fun record(f: Frame) {
        when (f.t) {
            "welcome" -> {
                welcome = f
                enter = null
                office.clear()
                floor.clear()
                workers.clear()
                return
            }
            "floor.enter" -> {
                if (welcome == null) return
                enter = f
                floor.clear()
                workers.clear()
                return
            }
            "worker.update", "worker.remove" -> {
                if (welcome == null) return
                val id = f.workerId ?: return
                // Re-inserted so the fold keeps the order the last word on each worker arrived in.
                workers.remove(id)
                workers[id] = f
                return
            }
        }
        if (welcome == null) return
        if (f.t in OFFICE_TOPICS) office[f.t] = f else if (f.t in FLOOR_TOPICS) floor[f.t] = f
    }

    /** The socket closed: what it said no longer holds. */
    fun reset() {
        welcome = null
        enter = null
        office.clear()
        floor.clear()
        workers.clear()
    }

    /** The floor the replay leaves a page on, or null before a welcome. */
    fun floorId(): String? = (enter ?: welcome)?.floor

    /** The frames that bring an empty store to now, oldest first; empty before a welcome. */
    fun snapshot(): List<String> {
        val w = welcome ?: return emptyList()
        return buildList {
            add(w.text)
            enter?.let { add(it.text) }
            office.values.forEach { add(it.text) }
            floor.values.forEach { add(it.text) }
            workers.values.forEach { add(it.text) }
        }
    }

    companion object {
        /** State broadcasts about the whole office: a new welcome replaces them, a floor change doesn't. */
        val OFFICE_TOPICS = setOf(
            "floors", "projectsDir", "upgrade", "machine", "sky", "jukebox", "leaveOnMerge", "freshMain", "subagents",
            "models.hidden", "whiteboardSkill", "prompts", "factory", "setup", "subscriptions", "visits",
        )

        /** State broadcasts about the floor this connection is on: a floor change replaces them. */
        val FLOOR_TOPICS = setOf("gh.issues", "gh.pulls", "pipelines", "jira", "jira.board", "autoHeal", "decor", "worktreeSetup")
    }
}

/** The connection as the app's React Native side sees it ([HostLog.link]). */
data class HostLinkState(val phase: String, val epoch: Long, val office: String?, val reason: String?) {
    companion object {
        const val IDLE = "idle"
        const val CONNECTING = "connecting"
        const val CONNECTED = "connected"
        const val OFFLINE = "offline"
        const val UNAUTHORIZED = "unauthorized"
    }
}

/**
 * The order the app's React Native side and its management view see the connection in. One counter
 * ([seq]) orders link changes, office lists and messages, so a bootstrap taken at seq N says exactly
 * which later events are news. [epoch] numbers sockets; a socket's frames count only after its
 * `welcome`, which is preceded by its `connected` link. Not thread-safe: the main thread owns it.
 */
class HostLog {
    sealed interface Event {
        val seq: Long

        data class Link(override val seq: Long, val link: HostLinkState) : Event
        data class Message(override val seq: Long, val epoch: Long, val frame: Frame) : Event
    }

    var seq = 0L
        private set
    var epoch = 0L
        private set

    /** The socket whose `welcome` has arrived and that is still open, or null. */
    var welcomed: Long? = null
        private set
    var link = HostLinkState(HostLinkState.IDLE, 0, null, null)
        private set

    /** The seq [link] was announced at. */
    var linkSeq = 0L
        private set
    val replay = StateReplay()

    /** A number from the shared counter, for an event this log doesn't keep (an office list). */
    fun next(): Long = ++seq

    /** A new socket opened: its number. */
    fun opened(): Long {
        epoch++
        welcomed = null
        replay.reset()
        return epoch
    }

    /** Socket [e] closed. */
    fun closed(e: Long) {
        if (e != epoch) return
        welcomed = null
        replay.reset()
    }

    /** The link now; an event when that is news. */
    fun link(phase: String, office: String?, reason: String?): Event.Link? {
        val next = HostLinkState(phase, epoch, office, reason)
        if (next == link) return null
        link = next
        linkSeq = next()
        return Event.Link(linkSeq, next)
    }

    /**
     * A frame from socket [e]: the events it makes, in order (a `connected` link first for a welcome
     * the link hadn't announced). Nothing from a socket that isn't the newest, or before its welcome.
     */
    fun frame(e: Long, f: Frame, office: String?): List<Event> {
        if (e != epoch) return emptyList()
        val out = ArrayList<Event>(2)
        if (f.t == "welcome") {
            welcomed = e
            link(HostLinkState.CONNECTED, office, null)?.let(out::add)
        } else if (welcomed != e) return emptyList()
        replay.record(f)
        out += Event.Message(next(), e, f)
        return out
    }
}

/**
 * Pictures uploaded for prompts not sent yet, by id, with the office, floor and route each went to.
 * Forgetting one goes to that office only, never whichever is active now; one sent with a prompt, or
 * already forgotten, is gone from here. At most [max], the oldest dropped first.
 */
class ImageOrigins<Route>(private val max: Int = 200) {
    data class Origin<Route>(val office: String, val floor: String, val route: Route)

    private val origins = LinkedHashMap<String, Origin<Route>>()

    fun record(id: String, office: String, floor: String, route: Route) {
        origins.remove(id)
        origins[id] = Origin(office, floor, route)
        while (origins.size > max) origins.remove(origins.keys.first())
    }

    /**
     * The upload [id] to forget, removed from here; null when it is unknown, on another floor, or
     * [office] is given and isn't where it went.
     */
    fun forget(id: String, floor: String, office: String?): Origin<Route>? {
        val o = origins[id] ?: return null
        if (o.floor != floor || (office != null && office != o.office)) return null
        origins.remove(id)
        return o
    }

    /** These went out with a prompt: the office has them now. */
    fun sent(ids: Collection<String>) = ids.forEach { origins.remove(it) }

    /** An office was forgotten on this phone: its uploads can't be reached any more. */
    fun dropOffice(office: String) {
        origins.values.removeAll { it.office == office }
    }

    val size: Int get() = origins.size
}
