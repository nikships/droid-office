package ai.factory.droidoffice.ui.worker

import ai.factory.droidoffice.R
import ai.factory.droidoffice.core.RichPage
import android.content.Context
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
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
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream

@Composable
internal fun rememberRichPage(zoom: Boolean, onMessage: (RichPage.Msg) -> Unit): RichBlockPage {
    val context = LocalContext.current
    return remember(context, zoom) { AndroidRichPage(context, zoom, onMessage) }
}

/** One offline drawing; only the bundle's main frame can speak to its host. */
private class AndroidRichPage(context: Context, zoom: Boolean, onMessage: (RichPage.Msg) -> Unit) : RichBlockPage(onMessage) {
    private val view = WebView(context)
    private var initialScale = 0f

    init {
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .addPathHandler("/fonts/", FontHandler(context))
            .build()
        view.settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            textZoom = 100
            setSupportZoom(zoom)
            builtInZoomControls = zoom
            displayZoomControls = false
            cacheMode = WebSettings.LOAD_NO_CACHE
            blockNetworkLoads = true
        }
        view.setBackgroundColor(Color.TRANSPARENT)
        if (zoom) view.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        view.isVerticalScrollBarEnabled = zoom
        view.isHorizontalScrollBarEnabled = zoom
        view.overScrollMode = View.OVER_SCROLL_NEVER
        view.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        view.webViewClient = object : WebViewClient() {
            override fun onScaleChanged(view: WebView, oldScale: Float, newScale: Float) {
                if (initialScale == 0f) initialScale = newScale
                onZoom?.invoke((newScale / initialScale * 100).toInt())
            }

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
                loader.shouldInterceptRequest(request.url) ?: WebResourceResponse("text/plain", "utf-8", 404, "Not found", emptyMap(), ByteArrayInputStream(ByteArray(0)))

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                received(RichPage.Msg.Drawn(-1, false, 0, null, "The page stopped"))
                return true
            }
        }
        val origin = "https://${WebViewAssetLoader.DEFAULT_DOMAIN}"
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(view, "OfficeBridge", setOf(origin)) { _, message, sender, main, _ ->
                if (main && sender.toString().trimEnd('/') == origin) message.data?.let(RichPage::decode)?.let(::received)
            }
            view.loadUrl("$origin/assets/richblock/index.html")
        } else view.post { received(RichPage.Msg.Drawn(-1, false, 0, null, "This WebView can't draw it")) }
    }

    override fun evaluate(script: String) { view.evaluateJavascript(script, null) }
    override fun changeZoom(inward: Boolean) { if (inward) view.zoomIn() else view.zoomOut() }
    @Composable override fun Surface(modifier: Modifier) = AndroidView(factory = { view }, modifier = modifier)
    override fun disposeView() {
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
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
}
