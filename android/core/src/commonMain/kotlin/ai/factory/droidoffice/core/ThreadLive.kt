package ai.factory.droidoffice.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * What a worker's turn is doing right now, beyond what its session file says yet (`ThreadLive` in
 * src/shared/thread-live.ts, sent as `thread.live` while `thread.watch` is on): its phase for the
 * status line, the message it is still writing, the tools running, and its session settings. Each
 * one replaces the last whole; [ThreadLiveState] keeps the newest by [rev].
 */
data class ThreadLive(
    val rev: Long,
    /** The office's clock when it was worked out: timers offset by how far this phone's clock is from it. */
    val at: Long,
    val status: Status,
    val working: String,
    val label: String? = null,
    val turnStartedAt: Long? = null,
    val phaseSince: Long? = null,
    /** The newest entry the office had: [stream] belongs after it, and only while it is still the newest here. */
    val after: String? = null,
    val stream: Stream? = null,
    val tools: List<Tool> = emptyList(),
    val waiting: Waiting? = null,
    val settings: ThreadSessionSettings? = null,
    /** The office-driven rewind in progress, if any. */
    val rewind: Rewind? = null,
    /** Droid's side chat (/btw) as the terminal shows it, while it is open. */
    val side: String? = null,
) {
    /** Factory's droidStatusIndicator states. */
    enum class Status(val wire: String) {
        Idle("idle"),
        Pondering("pondering"),
        Responding("responding"),
        Waiting("waiting"),
        Compacting("compacting");

        companion object {
            fun of(wire: String?): Status? = entries.firstOrNull { it.wire == wire }
        }
    }

    /** The assistant message being written, as plain text read off the terminal. */
    data class Stream(val kind: String, val text: String, val since: Long)

    data class Tool(
        val id: String?,
        val name: String,
        val startedAt: Long,
        /** `running` or `waiting_permission`. */
        val phase: String,
        val session: String? = null,
        val output: String? = null,
        val more: Int? = null,
    )

    /** `permission`, `question`, `spec` or `other`, and the call it asks about. */
    data class Waiting(val kind: String, val toolId: String? = null)

    data class Rewind(val entryId: String, val since: Long)

    companion object {
        fun of(e: JsonElement?): ThreadLive? {
            val o = e as? JsonObject ?: return null
            val rev = o.long("rev") ?: return null
            val at = o.long("at") ?: return null
            val status = Status.of(o.str("status")) ?: return null
            return ThreadLive(
                rev = rev,
                at = at,
                status = status,
                working = o.str("working") ?: "idle",
                label = o.str("label"),
                turnStartedAt = o.long("turnStartedAt"),
                phaseSince = o.long("phaseSince"),
                after = o.str("after"),
                stream = (o["stream"] as? JsonObject)?.let { s ->
                    val text = s.str("text") ?: return@let null
                    Stream(s.str("kind") ?: "text", text.take(STREAM_CHARS), s.long("since") ?: at)
                },
                tools = (o["tools"] as? JsonArray)?.mapNotNull { t ->
                    val obj = t as? JsonObject ?: return@mapNotNull null
                    val name = obj.str("name") ?: return@mapNotNull null
                    Tool(
                        id = obj.str("id"),
                        name = name,
                        startedAt = obj.long("startedAt") ?: at,
                        phase = obj.str("phase") ?: "running",
                        session = obj.str("session"),
                        output = obj.str("output")?.take(STREAM_CHARS),
                        more = obj.long("more")?.toInt(),
                    )
                }?.take(64).orEmpty(),
                waiting = (o["waiting"] as? JsonObject)?.let { Waiting(it.str("kind") ?: "other", it.str("toolId")) },
                settings = ThreadSessionSettings.of(o["settings"]),
                rewind = (o["rewind"] as? JsonObject)?.let { r -> r.str("entryId")?.let { Rewind(it, r.long("since") ?: at) } },
                side = (o["side"] as? JsonObject)?.str("text")?.take(STREAM_CHARS),
            )
        }

        private const val STREAM_CHARS = 40_000
    }
}

/** A session's model, effort, mode and autonomy, from its `settings.json` next to the session file. */
data class ThreadSessionSettings(
    val model: String? = null,
    val modelName: String? = null,
    val reasoningEffort: String? = null,
    /** `auto` or `spec`. */
    val interactionMode: String? = null,
    /** `off`, `low`, `medium` or `high`. */
    val autonomyLevel: String? = null,
    val autonomyMode: String? = null,
) {
    companion object {
        fun of(e: JsonElement?): ThreadSessionSettings? {
            val o = e as? JsonObject ?: return null
            return ThreadSessionSettings(
                model = o.str("model"),
                modelName = o.str("modelName"),
                reasoningEffort = o.str("reasoningEffort"),
                interactionMode = o.str("interactionMode"),
                autonomyLevel = o.str("autonomyLevel"),
                autonomyMode = o.str("autonomyMode"),
            )
        }
    }
}

/** The newest [ThreadLive] for one worker's session: one with a [ThreadLive.rev] no newer than what is held is dropped. */
class ThreadLiveState {
    var session: String? = null
        private set
    var live: ThreadLive? = null
        private set

    /** True when [next] replaced what was held. */
    fun receive(sessionId: String?, next: ThreadLive): Boolean = receive(sessionId, next, sessionId)

    /** The visible worker's session must match, including when it has no session yet. */
    fun receive(sessionId: String?, next: ThreadLive, expectedSession: String?): Boolean {
        if (sessionId != expectedSession) return false
        val held = live
        if (held != null && sessionId == session && next.rev <= held.rev) return false
        session = sessionId
        live = next
        return true
    }

    fun clear() {
        session = null
        live = null
    }
}

private fun JsonObject.long(k: String): Long? = (this[k] as? JsonPrimitive)?.let { p ->
    if (p is JsonNull) null else p.contentOrNull?.toDoubleOrNull()?.takeIf { it.isFinite() }?.toLong()
}

private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content
