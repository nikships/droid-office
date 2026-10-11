package ai.factory.droidoffice.ui.worker

import ai.factory.droidoffice.R
import ai.factory.droidoffice.core.PageMsg
import ai.factory.droidoffice.core.TermEvent
import ai.factory.droidoffice.core.TermPage
import ai.factory.droidoffice.core.TermPalette
import android.content.Context
import android.content.res.Resources
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
 * The WebView running the terminal page (assets/terminal/): xterm.js, the same emulator as the
 * office's own terminal window, fed the office's stream so it keeps the scrollback. The page and
 * its fonts load from the app itself, and every other request is refused: the page never reaches
 * the office, and never sees its address or a token. It types only what a swipe sends a
 * full-screen program; xterm's own replies to terminal queries stay in the page, so the phone
 * never answers the program alongside the desktop.
 */
class TerminalPage(context: Context, private val onMessage: (PageMsg) -> Unit, private val onGone: () -> Unit) {
    val view = WebView(context)
    var ready = false
        private set

    /** Hands the feed's events to the page, in order. */
    val listener: (TermEvent) -> Unit = { send(TermPage.event(it)) }

    init {
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .addPathHandler("/fonts/", FontHandler(context.resources))
            .build()
        view.settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            // The page lays text out at the phone's font scale itself (TermPage.config); the system
            // scaling it again would grow the glyphs past the cells xterm measured.
            textZoom = 100
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            cacheMode = WebSettings.LOAD_NO_CACHE
        }
        view.setBackgroundColor(TermPalette.BACKGROUND)
        view.isVerticalScrollBarEnabled = false
        view.isHorizontalScrollBarEnabled = false
        view.overScrollMode = View.OVER_SCROLL_NEVER
        // Touching the terminal leaves the composer's focus, and its keyboard, alone.
        view.isFocusable = false
        view.isFocusableInTouchMode = false
        // The terminal's text is read from the screen frames (Tags.Worker.TERMINAL), not xterm's DOM.
        view.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        view.webViewClient = Client(loader)
        view.addJavascriptInterface(Bridge(), "OfficeBridge")
        view.loadUrl(PAGE)
    }

    fun send(script: String) {
        if (ready) view.evaluateJavascript(script, null)
    }

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
            val msg = TermPage.decode(json) ?: return
            view.post {
                if (msg == PageMsg.Ready) ready = true
                onMessage(msg)
            }
        }
    }

    private class FontHandler(private val res: Resources) : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            val id = when (path) {
                "geist_mono.ttf" -> R.font.geist_mono
                "terminal_symbols.ttf" -> R.font.terminal_symbols
                else -> return null
            }
            return WebResourceResponse("font/ttf", null, res.openRawResource(id))
        }
    }

    private companion object {
        const val PAGE = "https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/terminal/index.html"

        fun refused() = WebResourceResponse("text/plain", "utf-8", 404, "Not found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }
}
