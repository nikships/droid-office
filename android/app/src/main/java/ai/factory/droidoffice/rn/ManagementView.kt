package ai.factory.droidoffice.rn

import ai.factory.droidoffice.core.ToolBinding
import ai.factory.droidoffice.core.ToolLifetime
import ai.factory.droidoffice.core.ToolPolicy
import ai.factory.droidoffice.core.WbAnswer
import ai.factory.droidoffice.core.WbPage
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Process
import android.webkit.WebChromeClient
import android.webkit.ValueCallback
import android.webkit.URLUtil
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.events.Event
import java.io.ByteArrayInputStream
import java.util.Base64
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.ensureActive
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
    private val subscriptions = ToolLifetime()
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
    private var layoutScheduled = false
    private var picker: Picker? = null
    private var export: Export? = null
    private var exportJob: Job? = null
    private var listeningForResults = false
    private val activityResults = object : BaseActivityEventListener() {
        override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
            picker?.takeIf { it.code == requestCode }?.let { got ->
                if (resultCode != Activity.RESULT_OK || !live(got.binding)) {
                    finishPicker(got, null)
                    return
                }
                // We build GET_CONTENT ourselves, so parse its bounded ClipData directly instead
                // of delegating to a WebView-provider-specific FileChooserParams implementation.
                val uris = runCatching {
                    val clip = data?.clipData
                    ToolPolicy.pickerItems(data?.data, clip?.itemCount, got.multiple) { i -> clip?.getItemAt(i)?.uri }?.toTypedArray()
                }.getOrNull()
                if (uris == null) {
                    finishPicker(got, null)
                    return
                }
                scope.launch {
                    val valid = withContext(Dispatchers.IO) {
                        val context = coroutineContext
                        uris.all {
                            context.ensureActive()
                            if (!live(got.binding)) throw CancellationException()
                            selectedUri(it, data, Intent.FLAG_GRANT_READ_URI_PERMISSION) &&
                                (got.directory || try {
                                    reactContext.contentResolver.openAssetFileDescriptor(it, "r")?.use { descriptor ->
                                        if (descriptor.length >= 0) ToolPolicy.responseFits(descriptor.length)
                                        else descriptor.createInputStream().use { stream ->
                                            ToolPolicy.streamFits(stream) {
                                                context.ensureActive()
                                                if (!live(got.binding)) throw CancellationException()
                                            }
                                        }
                                    } == true
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (_: Exception) {
                                    false
                                })
                        }
                    }
                    if (picker !== got) return@launch
                    if (!valid) tell("Choose readable files, each no larger than 25 MB.")
                    finishPicker(got, uris.takeIf { valid && live(got.binding) })
                }
                return
            }
            export?.takeIf { it.code == requestCode }?.let { got ->
                export = null
                val uri = data?.data
                if (resultCode != Activity.RESULT_OK || uri == null || !live(got.binding)) return
                exportJob = scope.launch {
                    try {
                        withContext(Dispatchers.IO) {
                            require(selectedUri(uri, data, Intent.FLAG_GRANT_WRITE_URI_PERMISSION))
                            ensureActive()
                            check(live(got.binding))
                            val stream = reactContext.contentResolver.openOutputStream(uri, "wt") ?: error("No destination")
                            stream.use {
                                ensureActive()
                                check(live(got.binding))
                                var offset = 0
                                while (offset < got.body.size) {
                                    ensureActive()
                                    check(live(got.binding))
                                    val size = minOf(64 * 1024, got.body.size - offset)
                                    it.write(got.body, offset, size)
                                    offset += size
                                }
                            }
                            ensureActive()
                            check(live(got.binding))
                        }
                        if (live(got.binding)) tell("Saved the file.")
                    } catch (e: CancellationException) {
                        // No retry: the selected destination may contain an incomplete file.
                        throw e
                    } catch (_: Exception) {
                        if (live(got.binding)) tell("The file could not be saved. The destination may be incomplete.")
                    } finally {
                        if (lifetime.matches(got.binding)) exportJob = null
                    }
                }
            }
        }
    }

    private class Picker(val binding: ToolBinding, val code: Int, val activity: Activity, val multiple: Boolean, val directory: Boolean, val callback: ValueCallback<Array<Uri>>)
    private class Export(val binding: ToolBinding, val code: Int, val activity: Activity, val body: ByteArray)

    fun setParams(value: String?) {
        args = ToolPolicy.cleanToolArgs(value?.takeIf { it.length <= ToolPolicy.JSON_MAX }?.let { runCatching { Json.parseToJsonElement(it) }.getOrNull() })
    }

    /** Fabric delivers the three props as one transaction, never open a half-updated tool. */
    fun applyProps() {
        val next = opening()
        if (next == applied) return
        applied = next
        if (connected || join == null) {
            // In-flight uploads and DOM callbacks belong to the tool that requested them. Replacing
            // the document also drops its drafts and pending mutations, rather than replaying them.
            restartJoin()
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (!listeningForResults && !disposed) {
            // ThemedReactContext forwards lifecycle listeners, but not activity-result listeners.
            reactContext.reactApplicationContext.addActivityEventListener(activityResults)
            listeningForResults = true
        }
        if (!disposed && join == null) restartJoin()
    }

    override fun onDetachedFromWindow() {
        stop()
        removeActivityListener()
        super.onDetachedFromWindow()
    }

    fun dispose() {
        if (disposed) return
        disposed = true
        stop()
        removeActivityListener()
        job.cancel()
    }

    private fun removeActivityListener() {
        if (!listeningForResults) return
        listeningForResults = false
        reactContext.reactApplicationContext.removeActivityEventListener(activityResults)
    }

    // Fabric lays out this host view, not the WebView it owns. A page added after the mounting
    // transaction needs an explicit child pass even when the parent's Yoga bounds did not change.
    override fun requestLayout() {
        super.requestLayout()
        if (layoutScheduled) return
        layoutScheduled = true
        post {
            layoutScheduled = false
            if (isAttachedToWindow && !disposed) layoutChildren()
        }
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = layoutChildren()

    private fun layoutChildren() {
        val w = (width - paddingLeft - paddingRight).coerceAtLeast(0)
        val h = (height - paddingTop - paddingBottom).coerceAtLeast(0)
        for (i in 0 until childCount) getChildAt(i).let {
            it.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
            it.layout(paddingLeft, paddingTop, paddingLeft + w, paddingTop + h)
        }
    }

    private fun stop() {
        subscriptions.replace(null, null)
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
        val subscription = subscriptions.snapshot()
        val joined = host.join(object : ManagementListener {
            override fun onFrame(epoch: Long, json: String) {
                if (disposed || !subscriptions.matches(subscription) || link?.epoch != epoch) return
                if (connected) {
                    frame(json)?.let { send(buildJsonObject { put("t", "server"); put("msg", it) }) }
                } else {
                    replayBytes += json.length.toLong() * 2
                    if (replayBytes > REPLAY_MAX) {
                        failReplay(subscription)
                    } else replay.add(json)
                }
            }

            override fun onLink(link: ManagementLink?, replay: List<String>) {
                if (disposed || !subscriptions.matches(subscription)) return
                send(buildJsonObject { put("t", "status"); put("up", false) })
                this@ManagementView.link = link
                this@ManagementView.replay = replay.toMutableList()
                replayBytes = replay.sumOf { it.length.toLong() * 2 }
                // A fresh document is essential: a queued postMessage from the old office must not
                // acquire the new office's authority just because React kept this native view.
                replacePage()
            }
        })
        if (disposed || !subscriptions.matches(subscription)) {
            joined.close()
            return
        }
        join = joined
        link = joined.link
        replay = joined.replay.toMutableList()
        replayBytes = replay.sumOf { it.length.toLong() * 2 }
        replacePage()
    }

    private fun failReplay(subscription: ToolBinding) {
        // Invalidate synchronously, but release after the host finishes iterating its listeners.
        if (!subscriptions.matches(subscription)) return
        val failed = subscriptions.replace(null, null)
        lifetime.replace(null, null)
        post {
            if (!subscriptions.matches(failed)) return@post
            stop()
            notice("The office sent too much state. Close and reopen this tool.")
        }
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
            failReplay(subscriptions.snapshot())
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
            // The host CSP seals the privileged document. Sandboxed artifacts retain ordinary
            // browser networking, without the native office credential or privileged bridge.
            blockNetworkLoads = false
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
        page.webChromeClient = Chrome(binding)
        page.setDownloadListener { url, _, disposition, mime, _ -> requestDownload(binding, url, disposition, mime) }
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
        picker?.let { got ->
            finishPicker(got, null)
            runCatching { got.activity.finishActivity(got.code) }
        }
        export?.let { got ->
            export = null
            runCatching { got.activity.finishActivity(got.code) }
        }
        job.cancelChildren()
        exportJob = null
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

    private fun live(binding: ToolBinding): Boolean =
        binding.officeId != null && binding.epoch != null && lifetime.matches(binding)

    private fun tell(message: String) { Toast.makeText(reactContext, message, Toast.LENGTH_LONG).show() }

    /** A result URI is untrusted. It must carry the requested temporary grant and not point at us. */
    private fun selectedUri(uri: Uri, result: Intent?, permission: Int): Boolean = runCatching {
        if (uri.scheme != "content" || uri.authority.isNullOrEmpty() || uri.userInfo != null || uri.fragment != null ||
            result == null || result.flags and permission == 0) return false
        val provider = reactContext.packageManager.resolveContentProvider(uri.authority!!, 0) ?: return false
        ToolPolicy.selectedContentUri(
            uri.toString(),
            result.flags and permission != 0,
            reactContext.checkUriPermission(uri, Process.myPid(), Process.myUid(), permission) == PackageManager.PERMISSION_GRANTED,
            provider.applicationInfo.uid,
            Process.myUid(),
        )
    }.getOrDefault(false)

    private fun finishPicker(got: Picker, uris: Array<Uri>?) {
        if (picker !== got) return
        picker = null
        got.callback.onReceiveValue(uris)
    }

    private inner class Chrome(private val binding: ToolBinding) : WebChromeClient() {
        override fun onShowFileChooser(page: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            val activity = reactContext.currentActivity
            if (page !== web || !live(binding) || activity == null || picker != null || export != null || exportJob != null) {
                callback.onReceiveValue(null)
                tell("Wait for the current file action, or reconnect to the office.")
                return true
            }
            if (Build.VERSION.SDK_INT >= 37 && params.permissionMode != FileChooserParams.PERMISSION_MODE_READ) {
                callback.onReceiveValue(null)
                tell("Tools may read selected files, not edit your device's folders.")
                return true
            }
            // The installed WebView reports mode 2 for folders. Its public MODE_OPEN_FOLDER
            // constant was exposed in API 37; the system tree picker itself exists since API 21.
            val directory = params.mode == 2
            val multiple = params.mode == FileChooserParams.MODE_OPEN_MULTIPLE
            if (!directory && !multiple && params.mode != FileChooserParams.MODE_OPEN) {
                callback.onReceiveValue(null)
                tell("Use the tool's Download button to save a file.")
                return true
            }
            val code = requestCodes.getAndIncrement()
            if (code > 0x7fff) {
                callback.onReceiveValue(null)
                tell("Reopen the app before choosing another file.")
                return true
            }
            val types = ToolPolicy.pickerTypes(params.acceptTypes.toList())
            val intent = if (directory) Intent(Intent.ACTION_OPEN_DOCUMENT_TREE) else Intent(Intent.ACTION_GET_CONTENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = types.singleOrNull() ?: "*/*"
                putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
            }
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            val got = Picker(binding, code, activity, multiple, directory, callback)
            picker = got
            try {
                // Never take a persistable grant. Only this user-selected result is returned to the
                // browser's file input; it gains no native socket, HTTP or arbitrary-file capability.
                activity.startActivityForResult(intent, code)
            } catch (_: Exception) {
                finishPicker(got, null)
                tell("No system file picker is available.")
            }
            return true
        }
    }

    private fun download(binding: ToolBinding, url: String, disposition: String?, mime: String?) {
        if (!live(binding)) return
        val request = ToolPolicy.download(url)
        if (request == null) {
            tell("Only files from this office can be saved here.")
            return
        }
        if (picker != null || export != null || exportJob != null) return
        val office = binding.officeId ?: return
        val epoch = binding.epoch ?: return
        exportJob = scope.launch {
            try {
                // fetch is blocking and owns its OfficeApi network timeout/stream cap. A coroutine
                // timeout cannot interrupt it; cancellation still prevents delivery after it returns.
                val fetched = withContext(Dispatchers.IO) {
                    ensureActive()
                    if (!live(binding)) return@withContext null
                    host.fetch(office, epoch, request.path, request.query).also {
                        ensureActive()
                        check(live(binding))
                    }
                }
                if (!live(binding)) return@launch
                if (fetched == null || fetched.code !in 200..299) {
                    tell("The office could not provide that download.")
                    return@launch
                }
                if (!ToolPolicy.responseFits(fetched.body.size.toLong())) {
                    tell("That download is too large to save here (25 MB at most).")
                    return@launch
                }
                val activity = reactContext.currentActivity ?: return@launch
                val code = requestCodes.getAndIncrement()
                if (code > 0x7fff) {
                    tell("Reopen the app before saving another file.")
                    return@launch
                }
                val contentType = (fetched.type ?: mime)?.takeIf(ToolPolicy::validContentType)?.substringBefore(';')
                    ?: "application/octet-stream"
                val header = fetched.headers.entries.firstOrNull { it.key.equals("content-disposition", true) }?.value ?: disposition
                val name = ToolPolicy.safeFilename(URLUtil.guessFileName(url, header, contentType))
                val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = contentType
                    putExtra(Intent.EXTRA_TITLE, name)
                    addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                }
                val got = Export(binding, code, activity, fetched.body)
                export = got
                try {
                    activity.startActivityForResult(intent, code)
                } catch (_: Exception) {
                    if (export === got) export = null
                    tell("No system save dialog is available.")
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                if (live(binding)) tell("The office could not provide that download.")
            } finally {
                if (lifetime.matches(binding)) exportJob = null
            }
        }
    }

    /** DownloadListener has no gesture bit. Accept it only for the main document's trusted click.
     * Android's explicit hasGesture callbacks also use this path, consuming any matching intent.
     * No new native bridge is exposed, and an opaque card cannot set the parent's private intent.
     */
    private fun requestDownload(binding: ToolBinding, url: String, disposition: String?, mime: String?, hasGesture: Boolean = false) {
        val page = web ?: return
        if (!live(binding) || ToolPolicy.download(url) == null) return
        val take = "Boolean(window.droidOfficeDownloadIntent && window.droidOfficeDownloadIntent(${JsonPrimitive(url)}))"
        page.evaluateJavascript(take) { trustedClick ->
            if (web === page && live(binding) && (hasGesture || trustedClick == "true")) download(binding, url, disposition, mime)
        }
    }

    private fun receive(binding: ToolBinding, value: JsonObject) {
        if (!lifetime.matches(binding)) return
        when (value.string("t")) {
            "send" -> {
                val msg = value["msg"] as? JsonObject ?: return
                if (msg.string("t") == null || msg.string("t") == "floor.go" || msg.toString().length > ToolPolicy.JSON_MAX) return
                val epoch = binding.epoch
                if (binding.officeId == null || epoch == null || join?.send?.invoke(epoch, msg.toString()) != true) {
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
                    else if (!ToolPolicy.responseFits(response.body.size.toLong())) {
                        error(id, 413, "That response is too large to open here (25 MB at most).")
                    } else if (response.status !in 200..599 || !ToolPolicy.validContentType(response.contentType)) {
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
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val uri = request.url
            if (!lifetime.matches(binding)) return refused()
            val sealed = local(uri) || ToolPolicy.cardNavigation(uri.toString(), request.isForMainFrame)
            if (!sealed) return if (ToolPolicy.artifactNetwork(uri.toString(), request.isForMainFrame)) null else refused()
            if (request.method != "GET") return refused()
            val path = uri.encodedPath ?: return refused()
            if (request.isForMainFrame && uri.toString() != PAGE) {
                val gesture = request.hasGesture()
                if (ToolPolicy.download(uri.toString()) != null) post { requestDownload(binding, uri.toString(), null, null, gesture) }
                return refused()
            }
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
            // Always force an opaque origin, including repo HTML/SVG with no upstream sandbox.
            // Keep the card's network/interactive capabilities; only the host owns the bridge.
            val headers = ToolPolicy.passthroughHeaders(answer.headers)
            return WebResourceResponse(answer.mime, answer.charset, answer.code, answer.reason, headers, ByteArrayInputStream(answer.body, answer.offset, answer.length))
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // The top document never navigates, even to an otherwise permitted card or file.
            if (request.isForMainFrame) {
                if (request.hasGesture() && request.method == "GET" && ToolPolicy.download(request.url.toString()) != null) {
                    requestDownload(binding, request.url.toString(), null, null, true)
                }
                return true
            }
            val uri = request.url
            if (ToolPolicy.artifactNetwork(uri.toString(), false) || ToolPolicy.cardNavigation(uri.toString(), false)) return false
            return !local(uri) || !ToolPolicy.passthrough(uri.encodedPath.orEmpty()) || !ToolPolicy.validQuery(uri.encodedQuery)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (lifetime.matches(binding)) {
                stop()
                notice("The tools page stopped. Close and reopen this tool.")
            }
            return true
        }

        override fun onPageFinished(view: WebView, url: String) {
            if (view === web && lifetime.matches(binding) && url == PAGE) view.evaluateJavascript(INSTALL_DOWNLOAD_INTENT, null)
        }
    }

    companion object {
        private const val ORIGIN = ToolPolicy.ORIGIN
        private const val ASSETS = "/assets/companion-tools/"
        private const val PAGE = ORIGIN + ASSETS + "index.html"
        private const val CHANNEL = "DroidOfficeTools"
        private val requestCodes = AtomicInteger(0x6000)
        private const val MESSAGE_MAX = ((ToolPolicy.UPLOAD_MAX + 2) / 3) * 4 + 65536
        private const val REPLAY_MAX = 32L * 1024 * 1024
        private const val HOST_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self'; media-src 'self' blob:; frame-src 'self' blob:; connect-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"
        // Main-frame only. Keyboard/accessibility clicks are trusted too; script-created click()
        // events cannot authorize a save. The URL-bound intent expires and is consumed exactly once.
        private val INSTALL_DOWNLOAD_INTENT = """
            (() => {
              if (window.droidOfficeDownloadIntent) return;
              let intent = null;
              Object.defineProperty(window, 'droidOfficeDownloadIntent', { value: (url) => {
                const pending = intent;
                intent = null;
                return !!pending && pending.url === url && performance.now() - pending.at <= 2000;
              } });
              document.addEventListener('click', (event) => {
                if (!event.isTrusted || event.defaultPrevented) return;
                const anchor = event.target instanceof Element ? event.target.closest('a[href][download]') : null;
                if (!anchor) return;
                const url = new URL(anchor.href, location.href);
                if (url.origin === location.origin) intent = { url: url.href, at: performance.now() };
              }, true);
            })();
        """.trimIndent()

        private fun local(uri: Uri): Boolean = uri.scheme == "https" && uri.encodedAuthority == "appassets.androidplatform.net" && uri.fragment == null
        private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
        private fun frame(raw: String): JsonObject? = runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull()
        private fun response(answer: WbAnswer) = WebResourceResponse(answer.mime, answer.charset, answer.code, answer.reason, answer.headers, ByteArrayInputStream(answer.body, answer.offset, answer.length))
        private fun refused() = response(WbPage.empty(403, "Forbidden"))
    }
}
