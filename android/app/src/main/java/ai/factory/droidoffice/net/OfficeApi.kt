package ai.factory.droidoffice.net

import ai.factory.droidoffice.core.DroidCommand
import ai.factory.droidoffice.core.DroidCommands
import ai.factory.droidoffice.core.Models
import ai.factory.droidoffice.core.HostUpdateState
import ai.factory.droidoffice.core.HostUpdateAction
import ai.factory.droidoffice.core.OfficeJson
import ai.factory.droidoffice.core.Probe
import ai.factory.droidoffice.core.WbFetched
import ai.factory.droidoffice.core.WbFileRef
import ai.factory.droidoffice.core.WbRenderStatus
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.BufferedSink
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** What the phone shows an office to get in: a device token as a bearer, or this start's LAN token as ?t=. */
sealed interface OfficeAuth {
    data class Device(val token: String) : OfficeAuth
    data class Lan(val token: String) : OfficeAuth
}

@Serializable
data class OfficeMeta(val name: String = "", val version: String = "")

@Serializable
data class PairResponse(val deviceId: String = "", val token: String = "", val office: OfficeMeta = OfficeMeta())

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
data class ModelCatalogue(val models: List<ModelOption> = emptyList(), val defaultModel: String? = null, val defaultReasoningEffort: String? = null)

/** What to call model [id]: the catalogue's name for it, else its id tidied up. */
fun ModelCatalogue?.nameOf(id: String): String = Models.displayName(id, this?.models?.firstOrNull { it.id == id }?.displayName)

sealed interface PairResult {
    data class Paired(val response: PairResponse) : PairResult
    /** The office has no /api/mobile routes: an older office, reachable with the LAN token only. */
    data object Unsupported : PairResult
    /** The LAN token was refused: the office restarted since the QR code was shown. */
    data object Refused : PairResult
    data class Failed(val message: String) : PairResult
}

/**
 * HTTP and WebSocket access to an office. Every request carries an Origin equal to the base URL
 * it goes to (the office checks it on the WebSocket upgrade and owner writes) and the office's auth.
 */
class OfficeApi(base: OkHttpClient = OkHttpClient()) {
    val client: OkHttpClient = base.newBuilder()
        .addNetworkInterceptor(CleartextGuard())
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val probeClient = client.newBuilder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(4, TimeUnit.SECONDS)
        .build()

    private val noRetryClient = client.newBuilder().retryOnConnectionFailure(false).followRedirects(false).build()

    private val jsonType = "application/json".toMediaType()

    suspend fun pair(base: String, lanToken: String, device: String): PairResult = withContext(Dispatchers.IO) {
        val url = base.toHttpUrl().newBuilder().addPathSegments("api/mobile/pair").addQueryParameter("t", lanToken).build()
        val body = buildJsonObject { put("device", device) }.toString().toRequestBody(jsonType)
        val request = Request.Builder().url(url).header("Origin", base).post(body).build()
        try {
            client.newCall(request).await().use { res ->
                when (res.code) {
                    200, 201 -> {
                        val parsed = runCatching { OfficeJson.decodeFromString<PairResponse>(res.body.string()) }.getOrNull()
                        if (parsed == null || parsed.token.isBlank()) PairResult.Failed("The office sent an answer the app can't read")
                        else PairResult.Paired(parsed)
                    }
                    404, 405 -> PairResult.Unsupported
                    401, 403 -> PairResult.Refused
                    else -> PairResult.Failed("The office answered ${res.code}")
                }
            }
        } catch (e: IOException) {
            PairResult.Failed(e.message ?: "Couldn't reach the office")
        }
    }

    /** One route's answer for [ai.factory.droidoffice.core.RouteRacer]. */
    suspend fun hello(base: String, auth: OfficeAuth): Probe = withContext(Dispatchers.IO) {
        val request = when (auth) {
            is OfficeAuth.Device -> request(base, "api/mobile/hello", auth).get().build()
            // An older office has no hello: its health check sits behind the same LAN gate.
            is OfficeAuth.Lan -> request(base, "api/health", auth).get().build()
        }
        try {
            probeClient.newCall(request).await().use { res ->
                when (res.code) {
                    200 -> {
                        val hello = if (auth is OfficeAuth.Device) runCatching { OfficeJson.decodeFromString<HelloResponse>(res.body.string()) }.getOrNull() else null
                        Probe.Ok(hello?.office?.name?.takeIf { it.isNotBlank() }, hello?.office?.version?.takeIf { it.isNotBlank() })
                    }
                    401, 403 -> Probe.Unauthorized
                    else -> Probe.Failed("HTTP ${res.code}")
                }
            }
        } catch (e: IOException) {
            Probe.Failed(e.message ?: e.javaClass.simpleName)
        }
    }

    suspend fun unpair(base: String, auth: OfficeAuth.Device): Boolean = withContext(Dispatchers.IO) {
        try {
            client.newCall(request(base, "api/mobile/pair", auth).delete().build()).await().use { it.isSuccessful || it.code == 401 }
        } catch (_: IOException) {
            false
        }
    }

    suspend fun models(base: String, auth: OfficeAuth): ModelCatalogue? = withContext(Dispatchers.IO) {
        try {
            client.newCall(request(base, "api/agents/droid/models", auth).get().build()).await().use { res ->
                if (!res.isSuccessful) null else runCatching { OfficeJson.decodeFromString<ModelCatalogue>(res.body.string()) }.getOrNull()
            }
        } catch (_: IOException) {
            null
        }
    }

    /** The skills and custom commands a worker's droid offers as slash commands; null when the office can't say. */
    suspend fun slashCommands(base: String, auth: OfficeAuth, workerId: String): List<DroidCommand>? = withContext(Dispatchers.IO) {
        try {
            client.newCall(request(base, "api/agents/droid/commands", auth, "worker" to workerId).get().build()).await().use { res ->
                if (!res.isSuccessful) null else runCatching { OfficeJson.decodeFromString<DroidCommands>(res.body.string()).commands }.getOrNull()
            }
        } catch (_: IOException) {
            null
        }
    }

    /** No automatic retries for commands that may restart the host. Poll status after an uncertain answer. */
    suspend fun hostUpdate(base: String, auth: OfficeAuth, action: HostUpdateAction? = null, version: String? = null): Result<HostUpdateState> = withContext(Dispatchers.IO) {
        val builder = request(base, "api/host/update", auth)
        if (action == null) builder.get() else {
            val body = buildJsonObject {
                put("action", action.wire)
                version?.let { put("version", it) }
            }.toString().toRequestBody(jsonType)
            builder.post(object : RequestBody() {
                override fun contentType() = body.contentType()
                override fun contentLength() = body.contentLength()
                // Also forbid response-driven retries (for example 503 with Retry-After: 0).
                override fun isOneShot() = true
                override fun writeTo(sink: BufferedSink) = body.writeTo(sink)
            })
        }
        try {
            (if (action == null) client else noRetryClient).newCall(builder.build()).await().use { res ->
                if (res.code == 404) Result.failure(IOException("This office is too old for remote host updates. Update it on the Mac first."))
                else if (!res.isSuccessful) {
                    val body = runCatching { OfficeJson.parseToJsonElement(res.body.string()) as? kotlinx.serialization.json.JsonObject }.getOrNull()
                    val error = (body?.get("error") as? kotlinx.serialization.json.JsonPrimitive)?.content
                    Result.failure(IOException(error ?: "The office answered ${res.code}"))
                } else Result.success(OfficeJson.decodeFromString<HostUpdateState>(res.body.string()))
            }
        } catch (e: IOException) {
            Result.failure(e)
        } catch (_: kotlinx.serialization.SerializationException) {
            Result.failure(IOException("The host sent an update status this app can't read."))
        }
    }

    /**
     * Keeps a picture on the office's machine for a prompt that isn't sent yet (POST
     * /api/prompt/image). Answers with its id for `images` on worker.prompt, or why it was refused.
     */
    suspend fun stageImage(base: String, auth: OfficeAuth, floor: String, name: String, type: String, bytes: ByteArray): Result<String> = withContext(Dispatchers.IO) {
        val url = request(base, "api/prompt/image", auth).build().url.newBuilder()
            .addQueryParameter("floor", floor).addQueryParameter("name", name).build()
        val req = request(base, "api/prompt/image", auth).url(url).post(bytes.toRequestBody(type.toMediaType())).build()
        try {
            client.newCall(req).await().use { res ->
                val body = runCatching { OfficeJson.parseToJsonElement(res.body.string()) as? kotlinx.serialization.json.JsonObject }.getOrNull()
                val id = (body?.get("id") as? kotlinx.serialization.json.JsonPrimitive)?.content
                val error = (body?.get("error") as? kotlinx.serialization.json.JsonPrimitive)?.content
                if (res.isSuccessful && id != null) Result.success(id) else Result.failure(IOException(error ?: "The office answered ${res.code}"))
            }
        } catch (e: IOException) {
            Result.failure(e)
        }
    }

    suspend fun unstageImage(base: String, auth: OfficeAuth, floor: String, id: String) = withContext(Dispatchers.IO) {
        val url = request(base, "api/prompt/image", auth).build().url.newBuilder().addQueryParameter("floor", floor).addQueryParameter("id", id).build()
        runCatching { client.newCall(request(base, "api/prompt/image", auth).url(url).delete().build()).await().close() }
    }

    /** A Whiteboard card's latest image size, tiles and canvas origin (GET /api/whiteboard/render/status). */
    suspend fun boardRenderStatus(base: String, auth: OfficeAuth, floor: String, card: String): WbRenderStatus? = withContext(Dispatchers.IO) {
        val req = request(base, "api/whiteboard/render/status", auth, "floor" to floor, "card" to card).get().build()
        try {
            client.newCall(req).await().use { res ->
                if (!res.isSuccessful) null else runCatching { OfficeJson.decodeFromString<WbRenderStatus>(res.body.string()) }.getOrNull()
            }
        } catch (_: IOException) {
            null
        }
    }

    /**
     * A card's latest image as PNG bytes (GET /api/whiteboard/render): its grid thumbnail, or one tile
     * of the full page. [version] is the render's time, so a newer render is never served from a cache.
     */
    suspend fun boardImage(base: String, auth: OfficeAuth, floor: String, card: String, thumb: Boolean, tile: Int, version: Long): ByteArray? = withContext(Dispatchers.IO) {
        val req = request(
            base, "api/whiteboard/render", auth,
            "floor" to floor, "card" to card, "size" to if (thumb) "thumb" else "full", "tile" to "$tile", "v" to "$version",
        ).get().build()
        try {
            client.newCall(req).await().use { res -> if (res.isSuccessful) res.body.bytes() else null }
        } catch (_: IOException) {
            null
        }
    }

    /**
     * A card's file for the live card page (GET /whiteboard/c/<cap>/<path>, [path] still
     * percent-encoded). The capability is its only credential, so no auth goes with it. Blocking: the
     * WebView asks on its own thread.
     */
    fun cardFile(base: String, cap: String, path: String): WbFetched? {
        val url = base.toHttpUrl().newBuilder().addPathSegments("whiteboard/c").addPathSegment(cap).apply { if (path.isNotEmpty()) addEncodedPathSegments(path) }.build()
        return fetch(Request.Builder().url(url).get().build())
    }

    /** A picture a card holds, by hash (GET /api/whiteboard/file), with the office's auth. Blocking. */
    fun boardFile(base: String, auth: OfficeAuth, floor: String, card: String, hash: String): WbFetched? =
        fetch(request(base, "api/whiteboard/file", auth, "floor" to floor, "card" to card, "hash" to hash).get().build())

    /** Uploads a picture for a batch that puts it on the board (POST /api/whiteboard/blob): its FileRef, or why not. */
    suspend fun boardBlob(base: String, auth: OfficeAuth, floor: String, mime: String, bytes: ByteArray): Result<WbFileRef> = withContext(Dispatchers.IO) {
        val req = request(base, "api/whiteboard/blob", auth, "floor" to floor, "mime" to mime).post(bytes.toRequestBody(mime.toMediaType())).build()
        try {
            client.newCall(req).await().use { res ->
                val text = res.body.string()
                val ref = if (res.isSuccessful) runCatching { OfficeJson.decodeFromString<WbFileRef>(text) }.getOrNull()?.takeIf { it.hash.isNotEmpty() } else null
                val error = runCatching { (OfficeJson.parseToJsonElement(text) as? kotlinx.serialization.json.JsonObject)?.get("error") as? kotlinx.serialization.json.JsonPrimitive }.getOrNull()?.content
                if (ref != null) Result.success(ref) else Result.failure(IOException(error ?: "The office answered ${res.code}"))
            }
        } catch (e: IOException) {
            Result.failure(e)
        }
    }

    /**
     * One of the client bundle's files the office serves openly (`/props/` models and `/fonts/`,
     * which carry no office data), for the overview page. [path] is still percent-encoded. Blocking.
     */
    fun publicFile(base: String, path: String): WbFetched? {
        val url = base.toHttpUrl().newBuilder().encodedPath(path).build()
        return fetch(Request.Builder().url(url).header("Origin", base).get().build())
    }

    /**
     * A management tool's request, already checked against ToolPolicy: [path] and [query] as the page
     * encoded them, with this office's auth added here and never shown to the page. Anything but a
     * GET goes once: no retry on a dropped connection, no redirect.
     */
    suspend fun tool(base: String, auth: OfficeAuth, method: String, path: String, query: String?, contentType: String?, body: ByteArray?): Result<WbFetched> = withContext(Dispatchers.IO) {
        val url = authed(base, path, query, auth)
        val payload = body?.toRequestBody(contentType?.toMediaType()) ?: if (method == "GET" || method == "DELETE") null else ByteArray(0).toRequestBody(contentType?.toMediaType())
        val req = Request.Builder().url(url).header("Origin", base).apply {
            if (auth is OfficeAuth.Device) header("Authorization", "Bearer ${auth.token}")
        }.method(method, payload).build()
        try {
            (if (method == "GET") client else noRetryClient).newCall(req).await().use { res ->
                val bytes = Capped.read(res.body.source(), res.body.contentLength(), RESPONSE_MAX)
                    ?: return@withContext Result.failure(IOException(TOO_LARGE))
                val headers = res.headers.names().associate { it.lowercase() to res.headers[it].orEmpty() }
                Result.success(WbFetched(res.code, res.header("Content-Type"), headers, bytes))
            }
        } catch (_: IOException) {
            Result.failure(IOException("Couldn't reach the office."))
        }
    }

    /**
     * A passthrough file for a management page ([path] still percent-encoded), with the office's auth;
     * null when unreachable or larger than [RESPONSE_MAX]. Blocking.
     */
    fun toolFile(base: String, auth: OfficeAuth, path: String, query: String?): WbFetched? {
        val req = Request.Builder().url(authed(base, path, query, auth)).header("Origin", base).apply {
            if (auth is OfficeAuth.Device) header("Authorization", "Bearer ${auth.token}")
        }.get().build()
        return fetch(req, RESPONSE_MAX)
    }

    private fun authed(base: String, path: String, query: String?, auth: OfficeAuth): HttpUrl =
        base.toHttpUrl().newBuilder().encodedPath(path).encodedQuery(query?.takeIf { it.isNotEmpty() }).apply {
            if (auth is OfficeAuth.Lan) addQueryParameter("t", auth.token)
        }.build()

    private fun fetch(req: Request, max: Long? = null): WbFetched? = try {
        client.newCall(req).execute().use { res ->
            val bytes = if (max == null) res.body.bytes() else Capped.read(res.body.source(), res.body.contentLength(), max) ?: return null
            val headers = res.headers.names().associate { it.lowercase() to res.headers[it].orEmpty() }
            WbFetched(res.code, res.header("Content-Type"), headers, bytes)
        }
    } catch (_: IOException) {
        null
    }

    fun socket(base: String, auth: OfficeAuth, floor: String?, name: String, listener: WebSocketListener): WebSocket {
        val http = base.toHttpUrl().newBuilder().addPathSegment("ws").apply {
            if (!floor.isNullOrBlank()) addQueryParameter("floor", floor)
            addQueryParameter("name", name.take(24))
            if (auth is OfficeAuth.Lan) addQueryParameter("t", auth.token)
        }.build()
        val builder = Request.Builder().url(http).header("Origin", base)
        if (auth is OfficeAuth.Device) builder.header("Authorization", "Bearer ${auth.token}")
        return client.newWebSocket(builder.build(), listener)
    }

    companion object {
        /** The most a management tool's request or file may answer with; the same as ToolPolicy's. */
        const val RESPONSE_MAX = 25L * 1024 * 1024
        private const val TOO_LARGE = "The office's answer is too large for the phone."
    }

    private fun request(base: String, path: String, auth: OfficeAuth, vararg query: Pair<String, String>): Request.Builder {
        val url: HttpUrl = base.toHttpUrl().newBuilder().addPathSegments(path).apply {
            for ((k, v) in query) addQueryParameter(k, v)
            if (auth is OfficeAuth.Lan) addQueryParameter("t", auth.token)
        }.build()
        return Request.Builder().url(url).header("Origin", base).apply {
            if (auth is OfficeAuth.Device) header("Authorization", "Bearer ${auth.token}")
        }
    }
}

internal suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (cont.isActive) cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            if (cont.isActive) cont.resume(response) else response.close()
        }
    })
}
