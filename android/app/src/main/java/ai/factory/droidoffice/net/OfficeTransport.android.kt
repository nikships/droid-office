package ai.factory.droidoffice.net

import ai.factory.droidoffice.core.WbFetched
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.BufferedSink

fun OfficeApi(base: OkHttpClient = OkHttpClient()): OfficeApi = OfficeApi(AndroidTransport(base))

private class AndroidTransport(base: OkHttpClient) : OfficeTransport {
    private val client = base.newBuilder()
        .addNetworkInterceptor(CleartextGuard())
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .build()
    private val probe = client.newBuilder().connectTimeout(3, TimeUnit.SECONDS).readTimeout(4, TimeUnit.SECONDS).build()
    private val writes = client.newBuilder().retryOnConnectionFailure(false).build()

    override fun pairingOrigins(bases: List<String>) = bases.filter(::canonicalOrigin).distinct()

    private fun request(r: OfficeRequest) = Request.Builder().url(r.url()).header("Origin", r.base).apply {
        r.bearer?.let { header("Authorization", it) }
        if (r.noStore) header("Cache-Control", "no-store")
        method(r.method, r.body?.let { bytes -> object : RequestBody() {
            override fun contentType() = r.contentType?.toMediaType()
            override fun contentLength() = bytes.size.toLong()
            // Prevent response-driven replays too (e.g. 503 with Retry-After: 0).
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) { sink.write(bytes) }
        } })
    }.build()

    private fun Response.read() = use {
        WbFetched(code, header("Content-Type"), headers.names().associate { it.lowercase() to headers[it].orEmpty() }, body.bytes())
    }

    override suspend fun execute(request: OfficeRequest): WbFetched = withContext(Dispatchers.IO) {
        val engine = when { request.probe -> probe; request.method != "GET" -> writes; else -> client }
        engine.newCall(request(request)).await().read()
    }

    override fun fetch(request: OfficeRequest) = client.newCall(request(request)).execute().read()

    override fun socket(request: OfficeRequest, listener: OfficeSocketListener): OfficeSocket {
        val ws = client.newWebSocket(request(request), object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) = listener.text(text)
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                listener.closed(code, reason)
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = listener.closed(code, reason)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = listener.failed(response?.code)
        })
        return object : OfficeSocket {
            override fun send(text: String) = ws.send(text)
            override fun cancel() = ws.cancel()
        }
    }
}

internal suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) { if (cont.isActive) cont.resumeWithException(e) }
        override fun onResponse(call: Call, response: Response) {
            cont.resume(response) { _, received, _ -> received.close() }
        }
    })
}
