package ai.factory.droidoffice.ui.overview

import ai.factory.droidoffice.core.MapMsg
import ai.factory.droidoffice.core.MapPage
import ai.factory.droidoffice.core.WbFetched
import android.content.Context
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream

/**
 * The WebView running the overview page (assets/overview/, built from src/client/android-overview.ts):
 * the web companion's 3D floor, fed the floor, its workers and their screens through [MapPage]. The
 * page loads from the app itself. Its 3D props and fonts come from the office's open `/props/` and
 * `/fonts/` routes, fetched here by [file], so the page never sees the office's address or a token;
 * every other request is refused and it can't navigate away.
 */
class OverviewPage(context: Context, private val file: (String) -> WbFetched?, private val onMessage: (MapMsg) -> Unit, private val onGone: () -> Unit) {
    val view = WebView(context)
    var ready = false
        private set

    init {
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .addPathHandler("/props/", OfficeFiles("/props/"))
            .addPathHandler("/fonts/", OfficeFiles("/fonts/"))
            .build()
        view.settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            textZoom = 100
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            cacheMode = WebSettings.LOAD_NO_CACHE
        }
        view.setBackgroundColor(BACKGROUND)
        view.isVerticalScrollBarEnabled = false
        view.isHorizontalScrollBarEnabled = false
        view.overScrollMode = View.OVER_SCROLL_NEVER
        // The roster next to the map names every worker; the canvas has nothing a screen reader can read.
        view.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        view.webViewClient = Client(loader)
        view.addJavascriptInterface(Bridge(), "OverviewBridge")
        view.loadUrl(PAGE)
    }

    fun send(script: String) {
        if (ready) view.evaluateJavascript(script, null)
    }

    fun pause() = view.onPause()

    fun resume() = view.onResume()

    fun destroy() {
        ready = false
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
    }

    private inner class Client(private val loader: WebViewAssetLoader) : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
            loader.shouldInterceptRequest(request.url) ?: refused()

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            ready = false
            onGone()
            return true
        }
    }

    private inner class Bridge {
        // Called on a WebView thread; the app handles it on the main thread.
        @JavascriptInterface
        fun post(json: String) {
            val msg = MapPage.decode(json) ?: return
            view.post {
                if (msg == MapMsg.Ready) ready = true
                onMessage(msg)
            }
        }
    }

    /** Answers on the WebView's own thread, so the blocking fetch is fine here. */
    private inner class OfficeFiles(private val prefix: String) : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse {
            if (path.isEmpty() || path.split('/').any { it == ".." }) return refused()
            val got = file(prefix + path.split('/').joinToString("/") { Uri.encode(it) })
            if (got == null || got.code !in 200..299) return refused()
            val type = got.type?.substringBefore(';')?.trim()?.ifEmpty { null } ?: "application/octet-stream"
            return WebResourceResponse(type, null, 200, "OK", emptyMap(), ByteArrayInputStream(got.body))
        }
    }

    private companion object {
        const val PAGE = "https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/overview/index.html"
        const val BACKGROUND = 0xFF050505.toInt()

        fun refused() = WebResourceResponse("text/plain", "utf-8", 404, "Not found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }
}
