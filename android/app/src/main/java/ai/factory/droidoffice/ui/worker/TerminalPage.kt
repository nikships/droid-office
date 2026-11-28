package ai.factory.droidoffice.ui.worker

import ai.factory.droidoffice.R
import ai.factory.droidoffice.core.PageMsg
import ai.factory.droidoffice.core.TermPage
import ai.factory.droidoffice.core.TermPalette
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.res.Resources
import android.os.Build
import android.os.PersistableBundle
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream

internal const val TERMINAL_UNAVAILABLE = "Could not open the terminal. Check for an Android System WebView update."

@Composable
internal fun rememberTerminalPage(onMessage: (TerminalPage, PageMsg) -> Unit, onGone: (TerminalPage) -> Unit): TerminalPage {
    val context = LocalContext.current
    return remember(context) { AndroidTerminalPage(context, onMessage, onGone) }
}

/**
 * The WebView running the terminal page (assets/terminal/): wterm, the same emulator as the
 * office's own terminal window, fed the office's stream so it keeps the scrollback. The page and
 * its fonts load from the app itself, and every other request is refused: the page never reaches
 * the office, and never sees its address or a token. Direct typing uses a native input connection;
 * the renderer's own replies to terminal queries stay in the page, so the phone
 * never answers the program alongside the desktop.
 */
private class AndroidTerminalPage(context: Context, onMessage: (TerminalPage, PageMsg) -> Unit, onGone: (TerminalPage) -> Unit) : TerminalPage(onMessage, onGone) {
    private val keyboard = TerminalKeyboard(context) { receive(PageMsg.Input(it)) }
    private val view: WebView = keyboard

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
            // scaling it again would grow the glyphs past the measured cells.
            textZoom = 100
            // Desktop view can fit a wide PTY below WebView's default 8px glyph floor.
            minimumFontSize = 1
            minimumLogicalFontSize = 1
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
        // The terminal's text is read from the screen frames (Tags.Worker.TERMINAL).
        view.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        view.webViewClient = Client(loader)
        view.addJavascriptInterface(Bridge(), "OfficeBridge")
        view.loadUrl(PAGE)
    }

    override fun evaluate(script: String) { view.evaluateJavascript(script, null) }

    @Composable
    override fun Surface(modifier: Modifier, unframed: Boolean, drawn: Boolean) {
        AndroidView(factory = { view }, modifier = modifier, update = {
            it.setBackgroundColor(if (unframed) android.graphics.Color.TRANSPARENT else TermPalette.BACKGROUND)
            it.alpha = if (unframed && !drawn) 0f else 1f
        })
    }

    override fun typeDirectly(enabled: Boolean) = keyboard.typeDirectly(enabled)

    override fun setCsiEnter(enabled: Boolean) { keyboard.csiEnter = enabled }

    override fun copyIfAttached(text: String) {
        if (!view.isAttachedToWindow) return
        runCatching {
            val clip = ClipData.newPlainText("Terminal", text)
            if (Build.VERSION.SDK_INT >= 33) {
                clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
            }
            view.context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(clip)
        }
    }

    override fun disposeView() {
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
    }

    private inner class Client(private val loader: WebViewAssetLoader) : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
            loader.shouldInterceptRequest(request.url)?.apply {
                // Do not depend on the Android release's MIME extension table.
                if (request.url.path == "/assets/terminal/vendor/ghostty-vt.wasm") {
                    mimeType = "application/wasm"
                    encoding = null
                }
            } ?: refused()

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            rendererGone()
            return true
        }
    }

    private inner class Bridge {
        // Called on a WebView thread; the app handles it on the main thread.
        @JavascriptInterface
        fun post(json: String) {
            val msg = TermPage.decode(json) ?: return
            view.post {
                if (ended) return@post
                if (msg is PageMsg.Kitty) keyboard.kittyFlags = msg.flags
                receive(msg)
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
