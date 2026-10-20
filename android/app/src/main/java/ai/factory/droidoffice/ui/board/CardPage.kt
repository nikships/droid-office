package ai.factory.droidoffice.ui.board

import ai.factory.droidoffice.R
import ai.factory.droidoffice.core.WbAnswer
import ai.factory.droidoffice.core.WbFetched
import ai.factory.droidoffice.core.WbPage
import ai.factory.droidoffice.core.WbPageMsg
import ai.factory.droidoffice.core.WbRoute
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Message
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream

/** Where the live card page's files come from: the office, on the route the app uses now. Both block. */
interface CardFiles {
    fun card(cap: String, path: String): WbFetched?
    fun picture(hash: String): WbFetched?
}

/**
 * The WebView running the live card page (assets/whiteboard/, routes and bridge in core/WbPage.kt):
 * the card in the office's sandboxed frame, playing, scrolling and taking input as it does in the
 * office's window, with its marks over it. The app's own client fetches every card file, so
 * CleartextGuard checks the address and the WebView never learns the office's address or token.
 */
class CardPage(
    private val context: Context,
    private val cardId: String,
    private val files: CardFiles,
    private val onMessage: (WbPageMsg) -> Unit,
    private val onGone: () -> Unit,
) {
    val view = WebView(context)
    /** Only this page can ask for the card's pictures: the frame, on an opaque origin, can't read it. */
    val secret = WbPage.newSecret()
    var ready = false
        private set
    private var destroyed = false

    /** What the card put in full screen (its video's own full-screen button), shown over the screen until it leaves. */
    var fullscreen by mutableStateOf<View?>(null)
        private set
    private var leftFullscreen: WebChromeClient.CustomViewCallback? = null

    init {
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .addPathHandler("/fonts/", FontHandler(context))
            .build()
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            // The page is laid out at the office's width and fitted to the phone; pinch zooms it.
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            // A card looks as it does in the office: the system's text scaling would reflow it.
            textZoom = 100
            mediaPlaybackRequiresUserGesture = true
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = false
            cacheMode = WebSettings.LOAD_NO_CACHE
        }
        view.setBackgroundColor(Color.rgb(0x1a, 0x1a, 0x1a))
        view.webViewClient = Client(loader)
        view.webChromeClient = Chrome()
        // Messages from the page itself only: never from the card's frame, which has an opaque origin.
        // Without the feature the page never says it's ready, and the screen shows the render instead (supported()).
        if (supported()) {
            WebViewCompat.addWebMessageListener(view, "OfficeBridge", setOf(WbPage.ORIGIN)) { _, message, origin, isMainFrame, _ ->
                if (!isMainFrame || origin.toString().trimEnd('/') != WbPage.ORIGIN) return@addWebMessageListener
                val msg = WbPage.decode(message.data ?: return@addWebMessageListener, cardId) ?: return@addWebMessageListener
                if (msg == WbPageMsg.Ready) ready = true
                onMessage(msg)
            }
        }
        view.loadUrl(WbPage.PAGE)
    }

    fun send(script: String) {
        if (ready && !destroyed) view.evaluateJavascript(script, null)
    }

    /** Back, or the screen going away, takes the card out of full screen. */
    fun leaveFullscreen() {
        val callback = leftFullscreen ?: return
        fullscreen = null
        leftFullscreen = null
        callback.onCustomViewHidden()
    }

    fun destroy() {
        leaveFullscreen()
        destroyed = true
        ready = false
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
    }

    private inner class Client(private val loader: WebViewAssetLoader) : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val url = request.url
            return when (val r = WbPage.route(url.scheme, url.host, url.encodedPath, secret)) {
                WbRoute.Asset -> loader.shouldInterceptRequest(url) ?: response(WbPage.empty(404, "Not Found"))
                is WbRoute.Card -> response(WbPage.answer(cached(r.cap, r.path, request), request.requestHeaders.entries.firstOrNull { it.key.equals("Range", true) }?.value))
                is WbRoute.File -> response(WbPage.answer(files.picture(r.hash), null))
                WbRoute.Refused -> response(WbPage.empty(404, "Not Found"))
                // The card's own network access, which the office's window gives it too.
                WbRoute.Network -> null
            }
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // The card's frame may follow its own links, as in the office's window; the page itself stays.
            if (!request.isForMainFrame) return false
            if (request.url.toString() != WbPage.PAGE) openOutside(request.url)
            return request.url.toString() != WbPage.PAGE
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            ready = false
            onGone()
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        // A WebView only shows element full screen through these; without them the frame's fullscreen grant does nothing.
        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (destroyed || fullscreen != null) {
                callback.onCustomViewHidden()
                return
            }
            fullscreen = view
            leftFullscreen = callback
        }

        override fun onHideCustomView() {
            fullscreen = null
            leftFullscreen = null
        }

        // A card's popup (allow-popups-to-escape-sandbox, a link with target=_blank) opens in the browser, as it leaves the office's window.
        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            if (!isUserGesture) return false
            val catcher = WebView(context)
            catcher.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                    openOutside(request.url)
                    v.destroy()
                    return true
                }

                override fun onRenderProcessGone(v: WebView, detail: RenderProcessGoneDetail): Boolean {
                    v.destroy()
                    return true
                }
            }
            (resultMsg.obj as WebView.WebViewTransport).webView = catcher
            resultMsg.sendToTarget()
            return true
        }
    }

    /**
     * One file the WebView asked for, fetched once per content version: a video asks for it again
     * and again in ranges while it plays and seeks, and the office sends whole files.
     */
    private val cache = LinkedHashMap<String, WbFetched>(8, 0.75f, true)
    private var cacheBytes = 0L
    /** The card's content version: a change empties the cache. */
    @Volatile var contentRev = 0L

    private fun cached(cap: String, path: String, request: WebResourceRequest): WbFetched? {
        val ranged = request.requestHeaders.keys.any { it.equals("Range", true) }
        val key = "$contentRev/$cap/$path"
        if (ranged) synchronized(cache) { cache[key]?.let { return it } }
        val f = files.card(cap, path) ?: return null
        if (ranged && f.code == 200 && f.body.size <= CACHE_ONE) synchronized(cache) {
            cache.keys.filter { !it.startsWith("$contentRev/") }.forEach { cacheBytes -= cache.remove(it)!!.body.size }
            cache.put(key, f)?.let { cacheBytes -= it.body.size }
            cacheBytes += f.body.size
            val it = cache.entries.iterator()
            while (cacheBytes > CACHE_ALL && it.hasNext()) {
                val e = it.next()
                if (e.key == key) continue
                cacheBytes -= e.value.body.size
                it.remove()
            }
        }
        return f
    }

    private fun openOutside(uri: Uri) {
        if (uri.scheme != "https" && uri.scheme != "http") return
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
            // No browser: the link stays where it was.
        }
    }

    private class FontHandler(private val context: Context) : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            val id = when (path) {
                "geist.ttf" -> R.font.geist
                else -> return null
            }
            return WebResourceResponse("font/ttf", null, context.resources.openRawResource(id))
        }
    }

    companion object {
        /** The largest file kept for its ranges (an asset's limit, MAX_ASSET_BYTES), and all of them together. */
        private const val CACHE_ONE = 10 * 1024 * 1024
        private const val CACHE_ALL = 40L * 1024 * 1024

        /** Whether this WebView can host the page: its bridge needs web message listeners. */
        fun supported(): Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)

        private fun response(a: WbAnswer) =
            WebResourceResponse(a.mime, a.charset, a.code, a.reason, a.headers, ByteArrayInputStream(a.body, a.offset, a.length))
    }
}
