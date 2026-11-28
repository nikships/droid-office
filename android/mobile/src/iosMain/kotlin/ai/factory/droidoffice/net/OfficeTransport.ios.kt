@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package ai.factory.droidoffice.net

import ai.factory.droidoffice.core.WbFetched
import ai.factory.droidoffice.data.toBytes
import ai.factory.droidoffice.data.toData
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.*
import platform.Foundation.*
import platform.darwin.NSObject

fun OfficeApi(): OfficeApi = OfficeApi(AppleTransport())

/** Read the platform stamped into the signed application, not a user default or environment flag. */
private val simulator = NSBundle.mainBundle.objectForInfoDictionaryKey("CFBundleSupportedPlatforms") == listOf("iPhoneSimulator")

private class SessionDelegate(private val listener: OfficeSocketListener?) : NSObject(), NSURLSessionWebSocketDelegateProtocol {
    override fun URLSession(session: NSURLSession, task: NSURLSessionTask, willPerformHTTPRedirection: NSHTTPURLResponse,
                            newRequest: NSURLRequest, completionHandler: (NSURLRequest?) -> Unit) = completionHandler(null)

    // Writes supply a one-shot body stream. Never supply another copy if URLSession asks to replay it.
    override fun URLSession(session: NSURLSession, task: NSURLSessionTask, needNewBodyStream: (NSInputStream?) -> Unit) = needNewBodyStream(null)

    override fun URLSession(session: NSURLSession, webSocketTask: NSURLSessionWebSocketTask, didCloseWithCode: Long, reason: NSData?) {
        listener?.closed(didCloseWithCode.toInt(), reason?.toBytes()?.decodeToString().orEmpty())
    }
}

private fun session(listener: OfficeSocketListener? = null): NSURLSession {
    val config = NSURLSessionConfiguration.ephemeralSessionConfiguration.apply {
        URLCache = null
        HTTPCookieStorage = null
        URLCredentialStorage = null
        timeoutIntervalForRequest = 15.0
        if (listener == null) timeoutIntervalForResource = 60.0
    }
    return NSURLSession.sessionWithConfiguration(config, SessionDelegate(listener), null)
}

private class AppleTransport : OfficeTransport {
    private val http = session()
    override fun pairingOrigins(bases: List<String>): List<String> = iosPairingOrigins(bases, simulator)

    private fun buildRequest(r: OfficeRequest, socket: Boolean = false): NSURLRequest {
        check(r.base in pairingOrigins(listOf(r.base))) { "This office needs HTTPS" }
        val httpUrl = r.url() // Check the credential's origin before attaching anything.
        val url = checkNotNull(NSURL.URLWithString(if (socket) "ws" + httpUrl.removePrefix("http") else httpUrl))
        return NSMutableURLRequest.requestWithURL(url, NSURLRequestReloadIgnoringLocalCacheData, if (r.probe) 4.0 else 15.0).apply {
            setHTTPMethod(r.method)
            setHTTPShouldHandleCookies(false)
            setValue(r.base, "Origin")
            r.bearer?.let { setValue(it, "Authorization") }
            if (r.noStore) setValue("no-store", "Cache-Control")
            r.contentType?.let { setValue(it, "Content-Type") }
            r.body?.let {
                setHTTPBodyStream(NSInputStream.inputStreamWithData(it.toData()))
                setValue(it.size.toString(), "Content-Length")
            }
        }
    }

    override suspend fun execute(request: OfficeRequest): WbFetched {
        // Building a prompt or Whiteboard upload copies the image into NSData; keep it off the UI thread.
        // Blocking web-resource GETs must not dispatch back to the worker pool they're running on.
        val req = if (request.body == null) buildRequest(request) else withContext(Dispatchers.Default) { buildRequest(request) }
        return suspendCancellableCoroutine { cont ->
            val task = http.dataTaskWithRequest(req) { data, response, error ->
                val res = response as? NSHTTPURLResponse
                if (error != null || res == null) cont.resumeWithException(IllegalStateException("Couldn't reach the office"))
                else {
                    val headers = res.allHeaderFields.entries.associate { it.key.toString().lowercase() to it.value.toString() }
                    cont.resume(WbFetched(res.statusCode.toInt(), headers["content-type"], headers, data?.toBytes() ?: byteArrayOf()))
                }
            }
            cont.invokeOnCancellation { task.cancel() }
            task.resume()
        }
    }

    override fun fetch(request: OfficeRequest) = runBlocking { execute(request) }

    override fun socket(request: OfficeRequest, listener: OfficeSocketListener): OfficeSocket {
        val req = buildRequest(request, socket = true)
        val socketSession = session(listener)
        val task = socketSession.webSocketTaskWithRequest(req)
        task.maximumMessageSize = 16L * 1024 * 1024
        fun failed() {
            if (task.closeCode != NSURLSessionWebSocketCloseCodeInvalid) listener.closed(task.closeCode.toInt(), task.closeReason?.toBytes()?.decodeToString().orEmpty())
            else listener.failed((task.response as? NSHTTPURLResponse)?.statusCode?.toInt())
        }
        fun receive() {
            task.receiveMessageWithCompletionHandler { frame, error ->
                if (error != null || frame == null) failed() else {
                    frame.string?.let(listener::text)
                    receive()
                }
            }
        }
        task.resume()
        receive()
        val heartbeat = CoroutineScope(Dispatchers.Default).launch {
            while (isActive) {
                delay(15_000)
                val ok = withTimeoutOrNull(15_000) {
                    suspendCancellableCoroutine { cont -> task.sendPingWithPongReceiveHandler { cont.resume(it == null) } }
                }
                if (ok != true) { failed(); break }
            }
        }
        return object : OfficeSocket {
            override fun send(text: String): Boolean {
                if (task.state != NSURLSessionTaskStateRunning) return false
                task.sendMessage(NSURLSessionWebSocketMessage(string = text)) { error -> if (error != null) failed() }
                return true // Accepted for sending; the reducer still awaits the server's action.result.
            }
            override fun cancel() {
                heartbeat.cancel()
                task.cancelWithCloseCode(NSURLSessionWebSocketCloseCodeGoingAway, null)
                socketSession.invalidateAndCancel()
            }
        }
    }
}
