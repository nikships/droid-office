package ai.factory.droidoffice.rn

import ai.factory.droidoffice.core.ToolBinding
import ai.factory.droidoffice.core.ToolLifetime
import ai.factory.droidoffice.core.ToolPolicy
import ai.factory.droidoffice.core.WbAnswer
import ai.factory.droidoffice.core.WbPage
import android.graphics.Color
import android.net.Uri
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.events.Event
import java.io.ByteArrayInputStream
import java.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put

/** APK-only tools; no address, device credential, arbitrary navigation or subframe native bridge. */
class ManagementView(
    private val reactContext: ThemedReactContext,
    private val host: ManagementHost,
) : FrameLayout(reactContext) {
    var tool = ""
    var floor = ""
    private var args = JsonObject(emptyMap())
    private var applied: JsonObject? = null
    private val lifetime = ToolLifetime()
    private val job = SupervisorJob()
    private val scope = CoroutineScope(job + Dispatchers.Main.immediate)
    private var web: WebView? = null
    private var join: ManagementJoin? = null
    private var link: ManagementLink? = null
    private var reply: JavaScriptReplyProxy? = null
    private var connected = false
    private var disposed = false
    private var replay = mutableListOf<String>()
    private var replayBytes = 0L
    private val requests = mutableSetOf<Long>()

    fun setParams(value: String?) {
        args = ToolPolicy.cleanToolArgs(value?.takeIf { it.length <= ToolPolicy.JSON_MAX }?.let { runCatching { Json.parseToJsonElement(it) }.getOrNull() })
    }

    /** Fabric delivers the three props as one transaction, never open a half-updated tool. */
    fun applyProps() {
        val next = opening()
        if (next == applied) return
        applied = next
        if (connected) {
            // In-flight uploads and DOM callbacks belong to the tool that requested them. Replacing
            // the document also drops its drafts and pending mutations, rather than replaying them.
            restartJoin()
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (!disposed && join == null) restartJoin()
    }

    override fun onDetachedFromWindow() {
        stop()
        super.onDetachedFromWindow()
    }

    fun dispose() {
        if (disposed) return
        disposed = true
        stop()
        job.cancel()
    }

    private fun stop() {
        lifetime.replace(null, null)
        val previous = join
        join = null
        previous?.close?.invoke()
        link = null
        replay.clear()
        replayBytes = 0
        destroyPage()
    }

    private fun restartJoin() {
        stop()
        if (disposed || !isAttachedToWindow) return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            notice("Update Android System WebView to open office tools.")
            return
        }
        val joined = host.join(object : ManagementListener {
            override fun onFrame(epoch: Long, json: String) {
                if (disposed || link?.epoch != epoch) return
                if (connected) {
                    frame(json)?.let { send(buildJsonObject { put("t", "server"); put("msg", it) }) }
                } else {
                    replayBytes += json.length.toLong() * 2
                    if (replayBytes > REPLAY_MAX) {
                        stop()
                        notice("The office sent too much state. Close and reopen this tool.")
                    } else replay.add(json)
                }
            }

            override fun onLink(link: ManagementLink?, replay: List<String>) {
                if (disposed) return
                send(buildJsonObject { put("t", "status"); put("up", false) })
                this@ManagementView.link = link
                this@ManagementView.replay = replay.toMutableList()
                replayBytes = replay.sumOf { it.length.toLong() * 2 }
                // A fresh document is essential: a queued postMessage from the old office must not
                // acquire the new office's authority just because React kept this native view.
                replacePage()
            }
        })
        join = joined
        link = joined.link
        replay = joined.replay.toMutableList()
        replayBytes = replay.sumOf { it.length.toLong() * 2 }
        replacePage()
    }

    private fun replacePage() {
        val binding = lifetime.replace(link?.officeId, link?.epoch)
        destroyPage()
        if (disposed || !isAttachedToWindow) return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            stop()
            notice("Update Android System WebView to open office tools.")
            return
        }
        if (replayBytes > REPLAY_MAX) {
            stop()
            notice("The office sent too much state. Close and reopen this tool.")
            return
        }
        val page = WebView(reactContext)
        web = page
        page.setBackgroundColor(Color.rgb(22, 22, 22))
        page.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            blockNetworkLoads = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(true)
            mediaPlaybackRequiresUserGesture = true
            cacheMode = WebSettings.LOAD_NO_CACHE
            textZoom = 100
        }
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(reactContext))
            .build()
        page.webViewClient = Client(binding, loader)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) WebViewCompat.addWebMessageListener(page, CHANNEL, setOf(ORIGIN)) { view, message, origin, isMainFrame, proxy ->
            if (view !== web || !lifetime.matches(binding) || !ToolPolicy.trustedMessage(origin.toString(), isMainFrame)) return@addWebMessageListener
            val raw = message.data ?: return@addWebMessageListener
            if (raw.length > MESSAGE_MAX) return@addWebMessageListener
            val value = runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return@addWebMessageListener
            if (value.string("t") == "connect") {
                if (connected) return@addWebMessageListener
                reply = proxy
                connected = true
                send(buildJsonObject {
                    put("t", "bootstrap")
                    put("up", binding.officeId != null)
                    put("messages", JsonArray(replay.mapNotNull(::frame)))
                    opening()?.let { put("open", it) }
                })
                replay.clear()
                replayBytes = 0
            } else if (connected) receive(binding, value)
        }
        removeAllViews()
        addView(page, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        page.loadUrl(PAGE)
    }

    private fun destroyPage() {
        job.cancelChildren()
        requests.clear()
        connected = false
        reply = null
        web?.let { page ->
            web = null
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) WebViewCompat.removeWebMessageListener(page, CHANNEL)
            page.stopLoading()
            removeView(page)
            page.destroy()
        }
    }

    private fun notice(text: String) {
        removeAllViews()
        addView(TextView(reactContext).apply {
            this.text = text
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.rgb(22, 22, 22))
            setPadding(24, 24, 24, 24)
        }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    private fun opening(): JsonObject? = if (tool.isEmpty() || tool.length > 64 || floor.length > 512) null else buildJsonObject {
        put("tool", tool)
        put("floor", floor)
        put("args", args)
    }

    private fun send(value: JsonObject) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) reply?.postMessage(value.toString())
    }

    private fun receive(binding: ToolBinding, value: JsonObject) {
        if (!lifetime.matches(binding)) return
        when (value.string("t")) {
            "send" -> {
                val msg = value["msg"] as? JsonObject ?: return
                if (msg.string("t") == null || msg.string("t") == "floor.go" || msg.toString().length > ToolPolicy.JSON_MAX) return
                val epoch = binding.epoch
                if (binding.officeId == null || epoch == null || !host.send(epoch, msg.toString())) {
                    send(buildJsonObject { put("t", "status"); put("up", false) })
                }
            }
            "http" -> http(binding, value)
            "open-worker" -> {
                if (binding.officeId == null) return
                val worker = value.string("workerId")?.takeIf { it.length in 1..64 } ?: return
                val view = value.string("view")?.takeIf { it == "thread" || it == "tty" } ?: return
                emit(buildJsonObject { put("kind", "open-worker"); put("workerId", worker); put("view", view) })
            }
            "switch-floor" -> {
                if (binding.officeId == null) return
                val floor = value.string("floor")?.takeIf { it.length in 1..512 } ?: return
                emit(buildJsonObject { put("kind", "switch-floor"); put("floor", floor) })
            }
            "closed" -> {
                send(buildJsonObject { put("t", "close") })
                emit(buildJsonObject { put("kind", "close") })
            }
            "external" -> value.string("url")?.takeIf(ToolPolicy::isExternalUrl)?.let(host::openExternal)
        }
    }

    private fun http(binding: ToolBinding, value: JsonObject) {
        val id = (value["id"] as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull
            ?.takeIf { it > 0 && it <= 9007199254740991.0 && it % 1.0 == 0.0 }?.toLong() ?: return
        // A duplicate never starts a second mutation or steals the first request's completion.
        if (id in requests) return
        if (binding.officeId == null || binding.epoch == null) return error(id, 503, "Not connected to the office.")
        if (requests.size >= 4) return error(id, 429, "Too many requests are already in progress.")
        val method = value.string("method")
        val path = value.string("path")
        val query = value.string("query")
        val contentType = value.string("contentType")
        val body = value.string("body")
        val encoded = (value["base64"] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull
        if (method == null || path == null || !ToolPolicy.allowed(method, path) || !ToolPolicy.validQuery(query) ||
            !ToolPolicy.validContentType(contentType) ||
            listOf("query", "contentType", "body").any { it in value && value.string(it) == null } ||
            ("base64" in value && encoded == null) || (method == "GET" && body != null)) {
            return error(id, 400, "That request is not allowed from this tool.")
        }
        requests.add(id)
        scope.launch {
            try {
                withTimeout(60_000) {
                    val decoded = withContext(Dispatchers.Default) { ToolPolicy.decodeBody(body, encoded == true, contentType) }
                    if (!lifetime.matches(binding)) return@withTimeout
                    val result = host.http(binding.officeId, binding.epoch, ToolHttpRequest(method, path, query, contentType, decoded))
                    if (!lifetime.matches(binding)) return@withTimeout
                    val response = result.getOrNull()
                    if (response == null) error(id, 502, "The office could not complete that request.")
                    else if (response.status !in 200..599 || !ToolPolicy.validContentType(response.contentType)) {
                        error(id, 502, "The office sent an invalid response.")
                    } else {
                        val output = withContext(Dispatchers.Default) { Base64.getEncoder().encodeToString(response.body) }
                        if (lifetime.matches(binding)) send(buildJsonObject {
                            put("t", "http.result"); put("id", id); put("status", response.status)
                            response.contentType?.let { put("contentType", it) }
                            put("body", output); put("base64", true)
                        })
                    }
                }
            } catch (e: CancellationException) {
                if (lifetime.matches(binding)) error(id, 504, "The office did not answer in time.")
                throw e
            } catch (_: IllegalArgumentException) {
                if (lifetime.matches(binding)) error(id, 400, "That request body is invalid or too large.")
            } catch (_: Exception) {
                if (lifetime.matches(binding)) error(id, 502, "The office could not complete that request.")
            } finally {
                if (lifetime.matches(binding)) requests.remove(id)
            }
        }
    }

    private fun error(id: Long, status: Int, message: String) = send(buildJsonObject {
        put("t", "http.result"); put("id", id); put("status", status); put("error", message)
    })

    private fun emit(value: JsonObject) {
        UIManagerHelper.getEventDispatcher(reactContext)?.dispatchEvent(
            ToolEvent(UIManagerHelper.getSurfaceId(this), id, value.toString()),
        )
    }

    private class ToolEvent(surface: Int, view: Int, private val data: String) : Event<ToolEvent>(surface, view) {
        override fun getEventName() = "topToolEvent"
        override fun canCoalesce() = false
        override fun getEventData(): WritableMap = Arguments.createMap().apply { putString("data", data) }
    }

    private inner class Client(private val binding: ToolBinding, private val loader: WebViewAssetLoader) : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
            val uri = request.url
            if (!lifetime.matches(binding) || request.method != "GET" || !local(uri)) return refused()
            val path = uri.encodedPath ?: return refused()
            if (request.isForMainFrame && uri.toString() != PAGE) return refused()
            if (ToolPolicy.bundledAsset(path)) {
                if (uri.encodedQuery != null) return refused()
                val response = loader.shouldInterceptRequest(uri) ?: return refused()
                response.responseHeaders = mapOf(
                    "Content-Security-Policy" to HOST_CSP,
                    "X-Content-Type-Options" to "nosniff",
                    "Cache-Control" to "no-store",
                    "Referrer-Policy" to "no-referrer",
                )
                return if (lifetime.matches(binding)) response else refused()
            }
            if (!ToolPolicy.passthrough(path) || !ToolPolicy.validQuery(uri.encodedQuery)) return refused()
            val office = binding.officeId ?: return refused()
            val epoch = binding.epoch ?: return refused()
            val fetched = runCatching { host.fetch(office, epoch, path, uri.encodedQuery) }.getOrNull()
            if (!lifetime.matches(binding)) return refused()
            val range = request.requestHeaders.entries.firstOrNull { it.key.equals("range", true) }?.value
            val answer = WbPage.answer(fetched, range)
            // Retain the server's Whiteboard sandbox and add a network ceiling. No frame can turn
            // a websocket, worker, popup or form into a route around request interception.
            val csp = answer.headers["content-security-policy"]
            val headers = answer.headers + mapOf(
                "content-security-policy" to listOfNotNull(csp, FRAME_CSP).joinToString(", "),
                "cache-control" to "no-store",
            )
            return WebResourceResponse(answer.mime, answer.charset, answer.code, answer.reason, headers, ByteArrayInputStream(answer.body, answer.offset, answer.length))
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // The top document never navigates, even to an otherwise permitted card or file.
            if (request.isForMainFrame) return true
            val uri = request.url
            return !local(uri) || !ToolPolicy.passthrough(uri.encodedPath.orEmpty()) || !ToolPolicy.validQuery(uri.encodedQuery)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (lifetime.matches(binding)) {
                stop()
                notice("The tools page stopped. Close and reopen this tool.")
            }
            return true
        }
    }

    companion object {
        private const val ORIGIN = ToolPolicy.ORIGIN
        private const val ASSETS = "/assets/companion-tools/"
        private const val PAGE = ORIGIN + ASSETS + "index.html"
        private const val CHANNEL = "DroidOfficeTools"
        private const val MESSAGE_MAX = ((ToolPolicy.UPLOAD_MAX + 2) / 3) * 4 + 65536
        private const val REPLAY_MAX = 32L * 1024 * 1024
        private const val HOST_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; frame-src 'self' blob:; connect-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"
        private const val FRAME_CSP = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src https://appassets.androidplatform.net; worker-src 'none'; frame-src 'self' blob:; form-action 'none'; base-uri 'none'; object-src 'none'"

        private fun local(uri: Uri): Boolean = uri.scheme == "https" && uri.encodedAuthority == "appassets.androidplatform.net" && uri.fragment == null
        private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
        private fun frame(raw: String): JsonObject? = runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull()
        private fun response(answer: WbAnswer) = WebResourceResponse(answer.mime, answer.charset, answer.code, answer.reason, answer.headers, ByteArrayInputStream(answer.body, answer.offset, answer.length))
        private fun refused() = response(WbPage.empty(403, "Forbidden"))
    }
}
