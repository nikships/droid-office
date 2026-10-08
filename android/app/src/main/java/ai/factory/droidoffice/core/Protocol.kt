package ai.factory.droidoffice.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

// The office's WebSocket protocol (src/shared/protocol.ts), as far as the phone needs it. Every frame
// is one JSON object whose `t` names it. Parsing is lenient on purpose: unknown messages, fields and
// enum values are skipped, so a newer office keeps working with an older app.

val OfficeJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
    coerceInputValues = true
    explicitNulls = false
    encodeDefaults = false
}

enum class WorkerStatus(val wire: String) {
    Starting("starting"),
    Idle("idle"),
    Working("working"),
    NeedsInput("needs_input"),
    Done("done"),
    Exited("exited"),
    Offline("offline"),
    Unknown("");

    /** Its process isn't running: it exited, or came back asleep after a restart. Resume wakes it. */
    val asleep get() = this == Exited || this == Offline

    /** In the middle of a turn: booting, working, or waiting on an answer. */
    val busy get() = this == Starting || this == Working || this == NeedsInput

    companion object {
        fun of(wire: String?): WorkerStatus = entries.firstOrNull { it.wire == wire && it != Unknown } ?: Unknown
    }
}

enum class Effort(val wire: String, val label: String) {
    Low("low", "Low"),
    Medium("medium", "Medium"),
    High("high", "High"),
    XHigh("xhigh", "X-High"),
    Max("max", "Max");

    companion object {
        fun of(wire: String?): Effort? = entries.firstOrNull { it.wire == wire }
    }
}

@Serializable
data class WorkerTask(val name: String = "", val summary: String = "")

@Serializable
data class WorktreeRef(val path: String = "", val branch: String = "", val base: String = "", val from: String? = null, val made: String? = null)

@Serializable
data class PrRef(val number: Int = 0, val url: String = "")

@Serializable
data class GuestInfo(val pid: Int = 0, val provider: String = "", val cwd: String = "", val seen: String = "")

/** A cloud worker's Factory computer (src/shared/factory-cloud.ts): its Droid session runs there, not in a terminal of the office's. */
@Serializable
data class CloudRef(val computerId: String = "", val computerName: String = "", val cwd: String? = null, val error: String? = null)

@Serializable
data class WorkerInfo(
    val id: String,
    val kind: String = "agent",
    val model: String? = null,
    val effort: String? = null,
    val activeModel: String? = null,
    val activeEffort: String? = null,
    val deskId: String = "",
    val name: String = "",
    val color: String = "#8c8c8c",
    val status: String = "idle",
    val downedUntil: Long? = null,
    val acked: Boolean = true,
    val waitingSince: Long? = null,
    val createdBy: String = "",
    val createdAt: Long = 0,
    val prompt: String? = null,
    val worktree: WorktreeRef? = null,
    val pr: PrRef? = null,
    val prOpening: Boolean = false,
    val title: String? = null,
    val sessionId: String? = null,
    val exitCode: Int? = null,
    val cols: Int = 80,
    val rows: Int = 24,
    val open: Boolean = false,
    val activity: String? = null,
    val action: String? = null,
    val task: WorkerTask? = null,
    val lastInputAt: Long? = null,
    val meeting: String? = null,
    val lead: String? = null,
    val workedMs: Long? = null,
    val workingSince: Long? = null,
    val guest: GuestInfo? = null,
    val cloud: CloudRef? = null,
) {
    val state: WorkerStatus get() = WorkerStatus.of(status)
    val isShell: Boolean get() = kind == "shell"
    val isGuest: Boolean get() = guest != null
    /** It works on a Factory computer: no terminal to show, but it takes prompts. */
    val isCloud: Boolean get() = kind == "cloud" || cloud != null
    /** A board agent standing at a kiosk (see STATIONS in src/shared/layout.ts), not hired at a desk. */
    val isStation: Boolean get() = deskId.startsWith("station-")
}

@Serializable
data class FloorInfo(
    val id: String,
    val name: String = "",
    val repo: String? = null,
    val dir: String = "",
    val branch: String? = null,
    val palette: Int = 0,
    val local: Boolean = false,
    val home: Boolean = false,
    val workers: Int = 0,
    val busy: Int = 0,
    val waiting: Int = 0,
)

@Serializable
data class ProjectInfo(val name: String = "", val dir: String = "", val branch: String? = null, val remote: String? = null, val forge: String = "github")

@Serializable
data class QueuePr(val number: Int = 0, val url: String = "", val state: String = "", val title: String = "")

@Serializable
data class QueueTask(
    val id: String,
    val title: String = "",
    val prompt: String = "",
    val status: String = "queued",
    val model: String? = null,
    val effort: String? = null,
    val addedBy: String = "",
    val addedAt: Long = 0,
    val workerId: String? = null,
    val workerName: String? = null,
    val outcome: String? = null,
    val pr: QueuePr? = null,
)

@Serializable
data class QueueState(val tasks: List<QueueTask> = emptyList(), val maxWorkers: Int = 0)

@Serializable
data class GhPull(
    val number: Int = 0,
    val title: String = "",
    val state: String = "",
    val isDraft: Boolean = false,
    val url: String = "",
    val headRefName: String = "",
    val checks: String = "none",
)

@Serializable
data class GhPulls(val items: List<GhPull> = emptyList(), val loading: Boolean = false, val error: String? = null)

@Serializable
data class Arrival(val floor: String? = null, val via: String = "", val removed: Boolean = false)

@Serializable
data class WorktreeState(
    val exists: Boolean = true,
    val dirty: Int = 0,
    val ahead: Int = 0,
    val unpushed: Int = 0,
    val error: String? = null,
)

/** A styled run of text on a terminal row: `[text, fg, bg, flags]`. */
data class Run(val text: String, val fg: Int = -1, val bg: Int = -1, val flags: Int = 0)

/** Everything on the floor this connection is on (FloorView), minus the 3D world. */
data class FloorView(
    val floor: String?,
    val project: ProjectInfo?,
    val workers: List<WorkerInfo>,
    val pulls: GhPulls,
    val queue: QueueState,
)

sealed interface ServerMsg {
    data class Welcome(val connection: String, val arrival: Arrival, val floors: List<FloorInfo>, val version: String, val view: FloorView) : ServerMsg
    data class FloorEnter(val arrival: Arrival, val view: FloorView) : ServerMsg
    data class Floors(val floors: List<FloorInfo>) : ServerMsg
    data class WorkerUpdate(val worker: WorkerInfo) : ServerMsg
    data class WorkerRemove(val workerId: String) : ServerMsg
    data class Worktree(val workerId: String, val state: WorktreeState) : ServerMsg
    data class Screen(val workerId: String, val cols: Int, val rows: Int, val lines: Map<Int, List<Run>>, val full: Boolean, val cursor: Pair<Int, Int>) : ServerMsg
    data class Toast(val text: String, val level: String, val workerId: String?) : ServerMsg
    data class Queue(val state: QueueState) : ServerMsg
    data class Pulls(val state: GhPulls) : ServerMsg
    data class Pong(val at: Long, val now: Long) : ServerMsg
    data class Ignored(val t: String) : ServerMsg
}

object Protocol {
    /** One frame from the office, or null when it isn't JSON at all. Unknown types come back as [ServerMsg.Ignored]. */
    fun decode(text: String): ServerMsg? {
        val obj = try {
            OfficeJson.parseToJsonElement(text) as? JsonObject
        } catch (_: Exception) {
            null
        } ?: return null
        val t = obj.str("t") ?: return null
        return try {
            decode(t, obj)
        } catch (_: Exception) {
            ServerMsg.Ignored(t)
        }
    }

    private fun decode(t: String, o: JsonObject): ServerMsg = when (t) {
        "welcome" -> ServerMsg.Welcome(
            connection = o.str("connection").orEmpty(),
            arrival = o.obj("arrival")?.let { OfficeJson.decodeFromJsonElement<Arrival>(it) } ?: Arrival(),
            floors = floors(o["floors"]),
            version = o.str("version").orEmpty(),
            view = floorView(o),
        )
        "floor.enter" -> ServerMsg.FloorEnter(
            arrival = o.obj("arrival")?.let { OfficeJson.decodeFromJsonElement<Arrival>(it) } ?: Arrival(),
            view = floorView(o),
        )
        "floors" -> ServerMsg.Floors(floors(o["floors"]))
        "worker.update" -> ServerMsg.WorkerUpdate(OfficeJson.decodeFromJsonElement(o.getValue("worker")))
        "worker.remove" -> ServerMsg.WorkerRemove(o.str("workerId").orEmpty())
        "worker.worktree" -> ServerMsg.Worktree(o.str("workerId").orEmpty(), o.obj("state")?.let { OfficeJson.decodeFromJsonElement<WorktreeState>(it) } ?: WorktreeState())
        "screen" -> screen(o)
        "toast" -> ServerMsg.Toast(o.str("text").orEmpty(), o.str("level") ?: "info", o.str("workerId"))
        "queue" -> ServerMsg.Queue(o.obj("state")?.let { OfficeJson.decodeFromJsonElement<QueueState>(it) } ?: QueueState())
        "gh.pulls" -> ServerMsg.Pulls(o.obj("state")?.let { OfficeJson.decodeFromJsonElement<GhPulls>(it) } ?: GhPulls())
        "pong" -> ServerMsg.Pong(o.long("at") ?: 0, o.long("now") ?: 0)
        else -> ServerMsg.Ignored(t)
    }

    private fun floors(e: JsonElement?): List<FloorInfo> =
        (e as? JsonArray)?.mapNotNull { runCatching { OfficeJson.decodeFromJsonElement<FloorInfo>(it) }.getOrNull() }.orEmpty()

    private fun workers(e: JsonElement?): List<WorkerInfo> =
        (e as? JsonArray)?.mapNotNull { runCatching { OfficeJson.decodeFromJsonElement<WorkerInfo>(it) }.getOrNull() }.orEmpty()

    private fun floorView(o: JsonObject) = FloorView(
        floor = o.str("floor"),
        project = o.obj("project")?.let { runCatching { OfficeJson.decodeFromJsonElement<ProjectInfo>(it) }.getOrNull() },
        workers = workers(o["workers"]),
        pulls = o.obj("pulls")?.let { runCatching { OfficeJson.decodeFromJsonElement<GhPulls>(it) }.getOrNull() } ?: GhPulls(),
        queue = o.obj("queue")?.let { runCatching { OfficeJson.decodeFromJsonElement<QueueState>(it) }.getOrNull() } ?: QueueState(),
    )

    private fun screen(o: JsonObject): ServerMsg.Screen {
        val lines = HashMap<Int, List<Run>>()
        o.obj("lines")?.forEach { (key, value) ->
            val row = key.toIntOrNull() ?: return@forEach
            lines[row] = (value as? JsonArray)?.mapNotNull(::run).orEmpty()
        }
        val cursor = (o["cursor"] as? JsonArray)?.let { (it.getOrNull(0)?.int() ?: 0) to (it.getOrNull(1)?.int() ?: 0) } ?: (0 to 0)
        return ServerMsg.Screen(
            workerId = o.str("workerId").orEmpty(),
            cols = o.int("cols") ?: 80,
            rows = o.int("rows") ?: 24,
            lines = lines,
            full = o.bool("full") ?: false,
            cursor = cursor,
        )
    }

    fun run(e: JsonElement): Run? {
        val a = e as? JsonArray ?: return null
        val text = (a.getOrNull(0) as? JsonPrimitive)?.contentOrNull ?: return null
        return Run(text, a.getOrNull(1)?.int() ?: -1, a.getOrNull(2)?.int() ?: -1, a.getOrNull(3)?.int() ?: 0)
    }

    private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content
    private fun JsonObject.obj(k: String) = this[k] as? JsonObject
    private fun JsonObject.int(k: String) = this[k]?.int()
    private fun JsonObject.long(k: String) = (this[k] as? JsonPrimitive)?.longOrNull
    private fun JsonObject.bool(k: String) = (this[k] as? JsonPrimitive)?.booleanOrNull
    private fun JsonElement.int(): Int? = (this as? JsonPrimitive)?.let { it.intOrNull ?: it.contentOrNull?.toDoubleOrNull()?.toInt() }
}

/** What the phone sends (ClientMsg). Optional fields are left out rather than sent as null. */
object ClientMsg {
    fun spawn(deskId: String, prompt: String?, worktree: Boolean, kind: String, model: String?, effort: String?): String = obj("worker.spawn") {
        put("deskId", deskId)
        if (!prompt.isNullOrBlank()) put("prompt", prompt)
        put("worktree", worktree)
        put("kind", kind)
        if (kind == "agent" && model != null) put("model", model)
        if (kind == "agent" && effort != null) put("effort", effort)
    }

    /** With [queue], an agent gets the prompt with Ctrl+Enter, so Droid queues it behind its current turn. */
    fun prompt(workerId: String, prompt: String, images: List<String> = emptyList(), queue: Boolean = false) = obj("worker.prompt") {
        put("workerId", workerId)
        put("prompt", prompt)
        if (images.isNotEmpty()) put("images", JsonArray(images.map { JsonPrimitive(it) }))
        if (queue) put("queue", true)
    }

    fun queueAdd(prompt: String, model: String?, effort: String?) = obj("queue.add") {
        put("prompt", prompt)
        if (model != null) put("model", model)
        if (effort != null) put("effort", effort)
    }

    fun termInput(workerId: String, data: String) = obj("term.input") {
        put("workerId", workerId)
        put("data", data)
    }

    fun termResize(workerId: String, cols: Int, rows: Int) = obj("term.resize") {
        put("workerId", workerId)
        put("cols", cols)
        put("rows", rows)
    }

    fun attach(workerId: String) = obj("worker.attach") { put("workerId", workerId) }
    fun detach(workerId: String) = obj("worker.detach") { put("workerId", workerId) }
    fun resume(workerId: String) = obj("worker.resume") { put("workerId", workerId) }
    fun pr(workerId: String) = obj("worker.pr") { put("workerId", workerId) }
    fun worktree(workerId: String) = obj("worker.worktree") { put("workerId", workerId) }

    fun kill(workerId: String, cleanup: String?) = obj("worker.kill") {
        put("workerId", workerId)
        if (cleanup != null) put("cleanup", cleanup)
    }

    fun floorGo(floor: String) = obj("floor.go") { put("floor", floor) }
    fun ping(at: Long) = obj("ping") { put("at", at) }

    private inline fun obj(t: String, crossinline body: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): String =
        buildJsonObject {
            put("t", t)
            body()
        }.toString()
}

/** Keys a TUI understands, as the bytes `term.input` types. */
object Keys {
    const val ENTER = "\r"
    const val ESC = "\u001b"
    const val TAB = "\t"
    const val SHIFT_TAB = "\u001b[Z"
    const val CTRL_C = "\u0003"
    const val BACKSPACE = "\u007f"
    const val UP = "\u001b[A"
    const val DOWN = "\u001b[B"
    const val RIGHT = "\u001b[C"
    const val LEFT = "\u001b[D"
}
