package ai.factory.droidoffice.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

// The Thread's presentation model as the office builds it (src/shared/thread-presentation.ts) and
// sends it on every thread.snapshot. The office decides what a thread hides, groups and says; the
// app only decodes these rows and renders them. Raw entries still come alongside: message and
// thought text, tool arguments and results are read from the entry with the row's, block's or
// action's id.

enum class ActivityState(val wire: String) {
    Working("working"),
    Complete("complete"),
    Incomplete("incomplete"),
    Failed("failed"),
    Cancelled("cancelled");

    companion object {
        fun of(wire: String?): ActivityState? = entries.firstOrNull { it.wire == wire }
    }
}

enum class NoticeTone(val wire: String) {
    Quiet("quiet"),
    Danger("danger"),
    Attachment("attachment");

    companion object {
        fun of(wire: String?): NoticeTone? = entries.firstOrNull { it.wire == wire }
    }
}

/** Where an action's arguments are in its entry's input: a key of the JSON object, `.` for a JSON string, or the whole input. */
data class ThreadArgumentsRef(val label: String, val field: String? = null) {
    /** The text this points at in [input], as the office's `threadArgumentsText` reads it. */
    fun text(input: String?): String {
        val raw = input?.trim().orEmpty()
        val key = field ?: return raw
        // JSON.parse's rules: the app's lenient reader would take a bare word for a string.
        val value = try {
            Json.parseToJsonElement(raw)
        } catch (_: Exception) {
            return raw
        }
        val picked = if (key == ".") value else (value as? JsonObject)?.get(key)
        return (picked as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim() ?: raw
    }
}

data class ThreadModelAction(
    /** The tool entry's id: its arguments and result are that entry's input and output. */
    val id: String,
    val title: String,
    val detail: String? = null,
    val category: String,
    val state: ActivityState,
    /** The state in words beside the title, empty when it simply finished. */
    val status: String,
    val causedBy: String? = null,
    val arguments: ThreadArgumentsRef? = null,
    /** The heading over the output: Result, Error or Cancelled. */
    val result: String,
    val open: Boolean = false,
)

data class ThreadFailure(val id: String, val title: String, val preview: String)

data class PlanStep(val done: Boolean, val active: Boolean, val text: String)

sealed interface ThreadBlock {
    val id: String
    val live: Boolean
    val open: Boolean

    data class Thought(override val id: String, val preview: String, override val live: Boolean, override val open: Boolean = false) : ThreadBlock

    data class Tools(
        override val id: String,
        val label: String,
        val state: ActivityState,
        override val live: Boolean,
        override val open: Boolean = false,
        val actions: List<ThreadModelAction>,
        /** The run's plan, only when it changed since the last one shown. */
        val plan: List<PlanStep>? = null,
    ) : ThreadBlock
}

/** [from] and [to] are the seqs of the first and last entry a row stands for, hidden ones included. */
sealed interface ThreadRow {
    val id: String
    val from: Long
    val to: Long
    /** Every entry the row stands for. */
    val sourceIds: List<String>

    data class Message(override val id: String, override val from: Long, override val to: Long, val role: ThreadRole, val startsTurn: Boolean) : ThreadRow {
        override val sourceIds get() = listOf(id)
    }

    data class Notice(override val id: String, override val from: Long, override val to: Long, val role: ThreadRole, val text: String, val tone: NoticeTone) : ThreadRow {
        override val sourceIds get() = listOf(id)
    }

    data class Activity(
        override val id: String,
        override val from: Long,
        override val to: Long,
        override val sourceIds: List<String>,
        val label: String,
        val state: ActivityState,
        val live: Boolean,
        val open: Boolean = false,
        /** "2 failed · 1 no result", when anything didn't simply finish. */
        val status: String? = null,
        /** The newest working action's title while live. */
        val running: String? = null,
        val failed: List<ThreadFailure> = emptyList(),
        val cancelled: Int = 0,
        val noResult: Int = 0,
        val blocks: List<ThreadBlock> = emptyList(),
    ) : ThreadRow
}

/** `presentation` of a thread.snapshot. Rows are only read for a [version] this app knows. */
data class ThreadPresentation(val version: Int, val rows: List<ThreadRow>) {
    companion object {
        /** The office's THREAD_MODEL_VERSION this app reads. */
        const val VERSION = 1

        /** Null when there is no presentation object at all: an office from before it. */
        fun of(e: JsonElement?): ThreadPresentation? {
            val o = e as? JsonObject ?: return null
            val version = o.int("version") ?: 0
            if (version != VERSION) return ThreadPresentation(version, emptyList())
            return ThreadPresentation(version, (o["rows"] as? JsonArray)?.mapNotNull(::row).orEmpty())
        }

        /** A row with no id or seqs, or of a kind, role or tone this version doesn't have, is skipped. */
        fun row(e: JsonElement): ThreadRow? {
            val o = e as? JsonObject ?: return null
            val id = o.str("id")?.takeIf { it.isNotEmpty() } ?: return null
            val from = o.long("from") ?: return null
            val to = o.long("to") ?: return null
            return when (o.str("kind")) {
                "message" -> ThreadRow.Message(id, from, to, ThreadRole.of(o.str("role")) ?: return null, o.bool("startsTurn") ?: false)
                "notice" -> ThreadRow.Notice(id, from, to, ThreadRole.of(o.str("role")) ?: return null, o.str("text").orEmpty(), NoticeTone.of(o.str("tone")) ?: return null)
                "activity" -> ThreadRow.Activity(
                    id = id,
                    from = from,
                    to = to,
                    sourceIds = o.strings("sourceIds"),
                    label = o.str("label").orEmpty(),
                    state = ActivityState.of(o.str("state")) ?: return null,
                    live = o.bool("live") ?: false,
                    open = o.bool("open") ?: false,
                    status = o.str("status"),
                    running = o.str("running"),
                    failed = (o["failed"] as? JsonArray)?.mapNotNull(::failure).orEmpty(),
                    cancelled = o.int("cancelled") ?: 0,
                    noResult = o.int("noResult") ?: 0,
                    blocks = (o["blocks"] as? JsonArray)?.mapNotNull(::block).orEmpty(),
                )
                else -> null
            }
        }

        private fun block(e: JsonElement): ThreadBlock? {
            val o = e as? JsonObject ?: return null
            val id = o.str("id")?.takeIf { it.isNotEmpty() } ?: return null
            return when (o.str("kind")) {
                "thought" -> ThreadBlock.Thought(id, o.str("preview").orEmpty(), o.bool("live") ?: false, o.bool("open") ?: false)
                "tools" -> ThreadBlock.Tools(
                    id = id,
                    label = o.str("label").orEmpty(),
                    state = ActivityState.of(o.str("state")) ?: return null,
                    live = o.bool("live") ?: false,
                    open = o.bool("open") ?: false,
                    actions = (o["actions"] as? JsonArray)?.mapNotNull(::action).orEmpty(),
                    plan = (o["plan"] as? JsonArray)?.mapNotNull(::step),
                )
                else -> null
            }
        }

        private fun action(e: JsonElement): ThreadModelAction? {
            val o = e as? JsonObject ?: return null
            return ThreadModelAction(
                id = o.str("id")?.takeIf { it.isNotEmpty() } ?: return null,
                title = o.str("title").orEmpty(),
                detail = o.str("detail"),
                category = o.str("category") ?: "other",
                state = ActivityState.of(o.str("state")) ?: return null,
                status = o.str("status").orEmpty(),
                causedBy = o.str("causedBy"),
                arguments = (o["arguments"] as? JsonObject)?.let { a -> a.str("label")?.let { ThreadArgumentsRef(it, a.str("field")) } },
                result = o.str("result") ?: "Result",
                open = o.bool("open") ?: false,
            )
        }

        private fun failure(e: JsonElement): ThreadFailure? {
            val o = e as? JsonObject ?: return null
            return ThreadFailure(o.str("id") ?: return null, o.str("title").orEmpty(), o.str("preview").orEmpty())
        }

        private fun step(e: JsonElement): PlanStep? {
            val o = e as? JsonObject ?: return null
            return PlanStep(o.bool("done") ?: false, o.bool("active") ?: false, o.str("text").orEmpty())
        }

        private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content
        private fun JsonObject.bool(k: String) = (this[k] as? JsonPrimitive)?.booleanOrNull
        private fun JsonObject.long(k: String) = (this[k] as? JsonPrimitive)?.let { it.longOrNull ?: it.contentOrNull?.toDoubleOrNull()?.toLong() }
        private fun JsonObject.int(k: String) = (this[k] as? JsonPrimitive)?.let { it.intOrNull ?: it.contentOrNull?.toDoubleOrNull()?.toInt() }
        private fun JsonObject.strings(k: String) = (this[k] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }.orEmpty()
    }
}

/** Whether the office's presentation can be shown: when it can't, the thread says why and offers Raw TTY. */
enum class ThreadSupport(
    /** The state's heading, or null when the Thread can be read. */
    val title: String?,
    val message: String?,
) {
    Supported(null, null),
    /** No presentation at all: the office predates it. */
    OlderOffice("Update Droid Office", "Update Droid Office on your computer to read this Thread here. Raw TTY still works."),
    /** A presentation version this app doesn't know. */
    NewerOffice("Update the app", "Update the app to read this Thread. Raw TTY still works.");

    companion object {
        fun of(p: ThreadPresentation?): ThreadSupport = when {
            p == null -> OlderOffice
            p.version == ThreadPresentation.VERSION -> Supported
            p.version > ThreadPresentation.VERSION -> NewerOffice
            else -> OlderOffice
        }
    }
}
