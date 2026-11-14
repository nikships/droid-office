package ai.factory.droidoffice.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement

// What the phone needs of the office's Factory state (src/shared/factory.ts FactoryState, sent on the
// welcome and as `{ t: 'factory', state }`): whether it's connected, and the computers and
// Environments a cloud worker can be hired on (src/shared/factory-cloud.ts, factory-environments.ts).

@Serializable
data class FactoryConnection(val connected: Boolean = false, val rejected: String? = null)

@Serializable
data class FactoryComputer(val id: String = "", val name: String = "", val providerType: String = "", val status: String = "active", val remoteUser: String? = null)

@Serializable
data class FactoryComputers(val items: List<FactoryComputer> = emptyList())

@Serializable
data class FactoryEnvRepo(val url: String = "")

@Serializable
data class FactoryEnvSource(val unavailable: Boolean = false)

@Serializable
data class FactoryEnvBuild(val status: String = "queued")

@Serializable
data class FactoryEnvironment(
    val id: String = "",
    val name: String = "",
    val isDefault: Boolean = false,
    val status: String = "building",
    val repositories: List<FactoryEnvRepo> = emptyList(),
    val source: FactoryEnvSource? = null,
    val latestBuild: FactoryEnvBuild? = null,
    val lastSuccessfulBuildAt: Double? = null,
)

@Serializable
data class FactoryEnvironments(val items: List<FactoryEnvironment> = emptyList())

@Serializable
data class FactoryState(
    val connection: FactoryConnection = FactoryConnection(),
    val computers: FactoryComputers = FactoryComputers(),
    val environments: FactoryEnvironments = FactoryEnvironments(),
    val limits: FactoryLimitsState = FactoryLimitsState(),
)

/** Where `worker.spawn` hires a cloud worker (CloudHire): exactly one of [computerId] and [environmentId]. */
data class CloudHire(val computerId: String? = null, val environmentId: String? = null, val cwd: String? = null)

/** The hire sheet's "Runs on", as the web's runsOnPicker offers it. */
sealed interface RunsOn {
    val key: String
    val label: String
    /** The choice's name in the phone's Runs on menu, with [detail] under it. */
    val title: String
    val detail: String

    data object ThisMachine : RunsOn {
        override val key = ""
        override val label = "💻 This machine"
        override val title = "This machine"
        override val detail = "The office's own computer, with a terminal here"
    }

    /** A fresh computer of its own, started from [env] for this worker alone. */
    data class Environment(val env: FactoryEnvironment) : RunsOn {
        override val key = "env:${env.id}"
        override val label = "⧉ ${env.name}${if (env.isDefault) " (default)" else ""}"
        override val title = env.name
        override val detail = "${if (env.isDefault) "Default Environment · " else ""}A fresh computer of its own"
    }

    data class Computer(val computer: FactoryComputer) : RunsOn {
        override val key = computer.id
        override val label = "☁ ${computer.name} · ${computer.providerType}"
        override val title = computer.name
        override val detail = when (computer.providerType) {
            "byom" -> "Your own machine, through Factory"
            "e2b" -> "A Factory computer"
            else -> computer.providerType
        }
    }
}

object FactoryCloud {
    fun parse(value: JsonElement?): FactoryState? =
        (value as? JsonObject)?.let { runCatching { OfficeJson.decodeFromJsonElement<FactoryState>(it) }.getOrNull() }

    private fun usable(s: FactoryState?) = s != null && s.connection.connected && s.connection.rejected == null

    /** Only an active computer can take a session. */
    fun canHost(c: FactoryComputer) = c.status == "active"

    private val IN_FLIGHT = setOf("queued", "building", "validating")

    /** A computer can start from it: it has a good build and its source is still there (environmentPhase is ready, updating or update failed). */
    fun canStartFrom(e: FactoryEnvironment): Boolean {
        if (e.source?.unavailable == true) return false
        if (e.lastSuccessfulBuildAt == null) return false
        val running = e.latestBuild?.status in IN_FLIGHT
        if (running || e.latestBuild?.status == "failed") return true
        return e.status != "failed"
    }

    fun computers(s: FactoryState?): List<FactoryComputer> = if (usable(s)) s!!.computers.items.filter(::canHost) else emptyList()

    /** The default first, then by name. */
    fun environments(s: FactoryState?): List<FactoryEnvironment> =
        if (usable(s)) s!!.environments.items.filter(::canStartFrom).sortedWith(compareByDescending<FactoryEnvironment> { it.isDefault }.thenBy { it.name }) else emptyList()

    /** This machine, then the Environments, then the computers; just this machine when there's nothing else to offer. */
    fun choices(s: FactoryState?): List<RunsOn> =
        listOf(RunsOn.ThisMachine) + environments(s).map(RunsOn::Environment) + computers(s).map(RunsOn::Computer)

    /** Where `~` is on a computer, when the office can tell: a managed (e2b) one is Linux with its user's home in /home. */
    fun computerHome(c: FactoryComputer): String? {
        val user = c.remoteUser
        if (c.providerType == "byom" || user.isNullOrEmpty() || !Regex("""^[\w.-]+$""").matches(user)) return null
        return "/home/$user"
    }

    /** A repository's folder name, lower-cased, from owner/name, a URL or a path. */
    fun repoName(repo: String?): String? =
        repo?.replace(Regex("""\.git/*$|/+$"""), "")?.split('/')?.filter { it.isNotEmpty() }?.lastOrNull()?.lowercase()

    /** The folder field's placeholder: what an empty folder means there. [floorRepo] is the floor's repository (owner/name). */
    fun folderPlaceholder(choice: RunsOn, floorRepo: String?): String? = when (choice) {
        RunsOn.ThisMachine -> null
        is RunsOn.Environment -> {
            val repo = floorRepo?.split('/')?.lastOrNull()
            val repos = choice.env.repositories
            // The same pick the server makes for an empty folder (repoFolder): this floor's repository, else the only one.
            val clone = repos.firstOrNull { repo != null && repoName(it.url) == repoName(repo) } ?: repos.singleOrNull()
            if (clone != null) "Empty for its clone of ${clone.url.removeSuffix(".git").split('/').last()}, or ~/…"
            else "Empty for its home folder (/home/factory-user), or ~/…"
        }
        is RunsOn.Computer -> computerHome(choice.computer)?.let { "Empty for its home folder ($it), or ~/repo" }
            ?: "Empty for its home folder, or a full path on ${choice.computer.name}"
    }

    /** The note under the folder field. */
    fun note(choice: RunsOn): String? = when (choice) {
        RunsOn.ThisMachine -> null
        is RunsOn.Environment -> "A computer of its own starts from ${choice.env.name} with everything installed (about 10 seconds), and is deleted when it goes home. Its Droid session runs in auto mode through Factory: no worktree or terminal here."
        is RunsOn.Computer -> "Its Droid session runs on ${choice.computer.name}, in auto mode, through Factory: no worktree or terminal here. Clone the repository there first if it isn't."
    }

    fun hire(choice: RunsOn, cwd: String): CloudHire? {
        val folder = cwd.trim().ifEmpty { null }
        return when (choice) {
            RunsOn.ThisMachine -> null
            is RunsOn.Environment -> CloudHire(environmentId = choice.env.id, cwd = folder)
            is RunsOn.Computer -> CloudHire(computerId = choice.computer.id, cwd = folder)
        }
    }

    /** What sending a cloud worker home does, as the office's own dialog says it (sendCloudHome). */
    fun sendHome(w: WorkerInfo): String {
        val c = w.cloud ?: return ""
        val where = c.computerName.ifBlank { "Factory" }
        if (c.instance) return "${w.name} leaves the desk, and the computer the office started for it from ${c.environmentName?.ifBlank { null } ?: "its Environment"} ($where) is deleted. Its session stays archived in Factory unless you delete it."
        val busy = w.state == WorkerStatus.Working || w.state == WorkerStatus.Starting
        return "${w.name} leaves the desk${if (busy) ", and its session on $where is stopped" else ""}. The session stays in Factory unless you delete it."
    }

    /** A BYOK model runs through the office's own keys, which a Factory computer doesn't have: the office refuses it there. */
    fun runsInCloud(modelId: String?) = modelId == null || !modelId.startsWith("custom:")
}
