package ai.factory.droidoffice.net

import ai.factory.droidoffice.core.DroidCommand
import ai.factory.droidoffice.core.DroidCommands
import ai.factory.droidoffice.core.HostUpdateAction
import ai.factory.droidoffice.core.HostUpdateState
import ai.factory.droidoffice.core.Models
import ai.factory.droidoffice.core.OfficeJson
import ai.factory.droidoffice.core.Probe
import ai.factory.droidoffice.core.WbFetched
import ai.factory.droidoffice.core.WbFileRef
import ai.factory.droidoffice.core.WbRenderStatus
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

@Serializable
data class OfficeMeta(val name: String = "", val version: String = "")

@Serializable
class PairResponse(val deviceId: String = "", val token: String = "", val office: OfficeMeta = OfficeMeta())

@Serializable
data class HelloResponse(val ok: Boolean = false, val office: OfficeMeta = OfficeMeta(), val deviceId: String? = null)

@Serializable
data class ModelOption(
    val id: String,
    val displayName: String = "",
    val custom: Boolean = false,
    val legacy: Boolean = false,
    val defaultReasoningEffort: String? = null,
    val supportedReasoningEfforts: List<String>? = null,
    val provider: String? = null,
    val tokenMultiplier: Double? = null,
    val noImages: Boolean = false,
    val promo: String? = null,
)

@Serializable
data class ThreadFiles(val files: List<String> = emptyList(), val dirs: List<String> = emptyList(), val truncated: Boolean = false)

@Serializable
data class ModelCatalogue(val models: List<ModelOption> = emptyList(), val defaultModel: String? = null, val defaultReasoningEffort: String? = null, val customOnly: Boolean = false)

fun ModelCatalogue?.nameOf(id: String): String = Models.displayName(id, this?.models?.firstOrNull { it.id == id }?.displayName)

sealed interface PairResult {
    data class Paired(val response: PairResponse) : PairResult
    data object Unsupported : PairResult
    data object Refused : PairResult
    data class Failed(val message: String) : PairResult
}

private val WbFetched.ok get() = code in 200..299
private inline fun <reified T> WbFetched.decode(): T? = runCatching { OfficeJson.decodeFromString<T>(body.decodeToString()) }.getOrNull()
private fun WbFetched.field(key: String): String? = (decode<JsonObject>()?.get(key) as? JsonPrimitive)?.content
private fun WbFetched.requireOk(fallback: String = "The office answered $code"): WbFetched = apply {
    if (!ok) error(field("error") ?: fallback)
}

private fun params(vararg pairs: Pair<String, String?>) = pairs.mapNotNull { (k, v) -> v?.let { k to it } }
private fun jsonBody(vararg fields: Pair<String, String?>) = buildJsonObject {
    for ((k, v) in fields) if (v != null) put(k, v)
}.toString().encodeToByteArray()

/** The phone's API contract. Only the HTTP engine, socket and route policy vary by platform. */
class OfficeApi internal constructor(private val transport: OfficeTransport) {
    fun pairingOrigins(bases: List<String>) = transport.pairingOrigins(bases)

    private suspend fun call(request: OfficeRequest): Result<WbFetched> = try {
        Result.success(transport.execute(request))
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        // Native errors may include a URL containing the LAN token or card capability.
        Result.failure(IllegalStateException("Couldn't reach the office"))
    }

    suspend fun pair(base: String, lan: OfficeAuth.Lan, device: String): PairResult {
        val req = OfficeRequest(base, "api/mobile/pair", lan, method = "POST", body = jsonBody("device" to device), contentType = "application/json")
        val res = call(req).getOrElse { return PairResult.Failed("Couldn't reach the office") }
        return when (res.code) {
            200, 201 -> res.decode<PairResponse>()?.takeIf { it.token.isNotBlank() && it.deviceId.isNotBlank() }?.let(PairResult::Paired)
                ?: PairResult.Failed("The office sent an answer the app can't read")
            404, 405 -> PairResult.Unsupported
            401, 403 -> PairResult.Refused
            else -> PairResult.Failed("The office answered ${res.code}")
        }
    }

    suspend fun hello(base: String, auth: OfficeAuth): Probe {
        // Older LAN-token offices only have /api/health.
        val path = if (auth is OfficeAuth.Device) "api/mobile/hello" else "api/health"
        val res = call(OfficeRequest(base, path, auth, probe = true)).getOrElse { return Probe.Failed("Couldn't reach the office") }
        return when (res.code) {
            200 -> if (auth is OfficeAuth.Lan) Probe.Ok() else {
                val hello = res.decode<HelloResponse>()?.takeIf { it.ok } ?: return Probe.Failed("Invalid hello from the office")
                if (auth is OfficeAuth.Device && auth.deviceId != null && hello.deviceId != auth.deviceId) Probe.Failed("The office didn't confirm this device")
                else Probe.Ok(hello.office.name.ifBlank { null }, hello.office.version.ifBlank { null })
            }
            401, 403 -> Probe.Unauthorized
            else -> Probe.Failed("HTTP ${res.code}")
        }
    }

    suspend fun unpair(base: String, auth: OfficeAuth.Device): Boolean =
        call(OfficeRequest(base, "api/mobile/pair", auth, method = "DELETE")).getOrNull()?.let { it.ok || it.code == 401 } == true

    private suspend fun read(req: OfficeRequest) = call(req).getOrNull()?.takeIf { it.ok }

    suspend fun models(base: String, auth: OfficeAuth): ModelCatalogue? =
        read(OfficeRequest(base, "api/agents/droid/models", auth))?.decode<ModelCatalogue>()

    suspend fun slashCommands(base: String, auth: OfficeAuth, workerId: String? = null, floorId: String? = null): List<DroidCommand>? {
        val query = when {
            workerId != null -> listOf("worker" to workerId)
            floorId != null -> listOf("floor" to floorId)
            else -> return null
        }
        return read(OfficeRequest(base, "api/agents/droid/commands", auth, query))?.decode<DroidCommands>()?.commands
    }

    suspend fun appRelease(base: String, auth: OfficeAuth): Result<String> =
        call(OfficeRequest(base, "api/mobile/app-release", auth, noStore = true)).mapCatching {
            if (it.code == 404) error("Update the office on your Mac to check for app updates.")
            it.requireOk().body.decodeToString()
        }

    suspend fun hostUpdate(base: String, auth: OfficeAuth, action: HostUpdateAction? = null, version: String? = null): Result<HostUpdateState> {
        val path = "api/host/update"
        val req = if (action == null) OfficeRequest(base, path, auth) else
            OfficeRequest(base, path, auth, method = "POST", body = jsonBody("action" to action.wire, "version" to version), contentType = "application/json")
        return call(req).mapCatching {
            if (it.code == 404) error("This office is too old for remote host updates. Update it on the Mac first.")
            it.requireOk().decode<HostUpdateState>() ?: error("The host sent an update status this app can't read.")
        }
    }

    suspend fun factoryOverage(base: String, auth: OfficeAuth, preference: String): Result<Unit> {
        if (preference !in setOf("droidCore", "extraUsage")) return Result.failure(IllegalArgumentException("Unknown overage preference"))
        val req = OfficeRequest(base, "api/factory/limits/overage", auth, method = "POST", body = jsonBody("overagePreference" to preference), contentType = "application/json")
        val res = call(req).getOrElse { return Result.failure(IllegalStateException("Couldn't confirm the overage preference. Check the office's current mode before trying again.")) }
        return if (res.ok) Result.success(Unit) else Result.failure(IllegalStateException(
            res.field("error") ?: "The office answered ${res.code}. Overage preference was not confirmed.",
        ))
    }

    suspend fun stageImage(base: String, auth: OfficeAuth, floor: String?, name: String, type: String, bytes: ByteArray, worker: String? = null): Result<String> =
        call(OfficeRequest(base, "api/prompt/image", auth, params("floor" to floor, "worker" to worker, "name" to name), "POST", bytes, type)).mapCatching {
            it.requireOk().field("id") ?: error("The office didn't return an image ID")
        }

    suspend fun unstageImage(base: String, auth: OfficeAuth, floor: String?, id: String, worker: String? = null) {
        call(OfficeRequest(base, "api/prompt/image", auth, params("floor" to floor, "worker" to worker, "id" to id), "DELETE"))
    }

    suspend fun boardRenderStatus(base: String, auth: OfficeAuth, floor: String, card: String): WbRenderStatus? =
        read(OfficeRequest(base, "api/whiteboard/render/status", auth, params("floor" to floor, "card" to card)))?.decode<WbRenderStatus>()

    suspend fun threadFiles(base: String, auth: OfficeAuth, floor: String?, worker: String?, query: String): ThreadFiles? =
        read(OfficeRequest(base, "api/thread/files", auth, params("floor" to floor, "worker" to worker, "q" to query.ifEmpty { null }), noStore = true))?.decode<ThreadFiles>()

    suspend fun threadFile(base: String, auth: OfficeAuth, floor: String?, worker: String, path: String): Result<Pair<Int, String>> =
        call(OfficeRequest(base, "api/thread/file", auth, params("floor" to floor, "worker" to worker, "path" to path))).map { it.code to it.body.decodeToString() }

    suspend fun threadImage(base: String, auth: OfficeAuth, floor: String, worker: String, image: String): ByteArray? =
        read(OfficeRequest(base, "api/thread/image", auth, params("floor" to floor, "worker" to worker, "image" to image)))?.body

    suspend fun threadFileImage(base: String, auth: OfficeAuth, floor: String, worker: String, path: String): ByteArray? =
        read(OfficeRequest(base, "api/thread/file", auth, params("floor" to floor, "worker" to worker, "path" to path, "raw" to "image")))?.body

    suspend fun webImage(base: String, auth: OfficeAuth, url: String): ByteArray? =
        read(OfficeRequest(base, "api/image", auth, params("url" to url)))?.body

    suspend fun boardImage(base: String, auth: OfficeAuth, floor: String, card: String, thumb: Boolean, tile: Int, version: Long): ByteArray? =
        read(OfficeRequest(base, "api/whiteboard/render", auth, params("floor" to floor, "card" to card, "size" to if (thumb) "thumb" else "full", "tile" to "$tile", "v" to "$version")))?.body

    /** These resource handlers are blocking, and the card capability is its only credential. */
    fun cardFile(base: String, cap: String, path: String): WbFetched? =
        fetch(OfficeRequest(base, "whiteboard/c/${urlPart(cap)}" + if (path.isEmpty()) "" else "/$path"))

    fun boardFile(base: String, auth: OfficeAuth, floor: String, card: String, hash: String): WbFetched? =
        fetch(OfficeRequest(base, "api/whiteboard/file", auth, params("floor" to floor, "card" to card, "hash" to hash)))

    fun publicFile(base: String, path: String): WbFetched? = fetch(OfficeRequest(base, path.removePrefix("/")))

    private fun fetch(req: OfficeRequest) = runCatching { transport.fetch(req) }.getOrNull()

    suspend fun boardBlob(base: String, auth: OfficeAuth, floor: String, mime: String, bytes: ByteArray): Result<WbFileRef> =
        call(OfficeRequest(base, "api/whiteboard/blob", auth, params("floor" to floor, "mime" to mime), "POST", bytes, mime)).mapCatching { res ->
            res.requireOk().decode<WbFileRef>()?.takeIf { it.hash.isNotEmpty() } ?: error("The office didn't return a file reference")
        }

    fun socket(base: String, auth: OfficeAuth, floor: String?, name: String, listener: OfficeSocketListener): OfficeSocket =
        transport.socket(OfficeRequest(base, "ws", auth, params("floor" to floor?.ifBlank { null }, "name" to name.take(24))), listener)
}
