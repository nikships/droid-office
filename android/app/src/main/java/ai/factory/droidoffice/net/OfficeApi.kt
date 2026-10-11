package ai.factory.droidoffice.net

import ai.factory.droidoffice.core.Models
import ai.factory.droidoffice.core.OfficeJson
import ai.factory.droidoffice.core.Probe
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
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
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

    private fun request(base: String, path: String, auth: OfficeAuth): Request.Builder {
        val url: HttpUrl = base.toHttpUrl().newBuilder().addPathSegments(path).apply {
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
