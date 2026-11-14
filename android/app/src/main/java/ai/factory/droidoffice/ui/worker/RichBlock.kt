package ai.factory.droidoffice.ui.worker

import ai.factory.droidoffice.R
import ai.factory.droidoffice.core.Markdown
import ai.factory.droidoffice.core.RichPage
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import android.content.Context
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream

/** A diagram the page drew: its sanitized SVG, and the height (dp) it took at the Thread's width. */
private data class Drawing(val svg: String, val height: Int)

/**
 * Drawn diagrams by source, so a block scrolled back into view, switched back from its source or
 * opened full screen shows again without Mermaid. Touched only on the main thread.
 */
private object Drawings {
    private const val MAX = 64
    private val cache = object : LinkedHashMap<String, Drawing>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Drawing>?) = size > MAX
    }

    operator fun get(source: String): Drawing? = cache[source]

    operator fun set(source: String, d: Drawing) {
        cache[source] = d
    }
}

/**
 * The WebView running the rich block page (assets/richblock/, messages in core/RichPage.kt): one
 * drawing, offline. The page and its libraries load from the app itself and every other request is
 * refused, so a message's diagram can't reach the network, the office or a token.
 */
private class RichBlockPage(context: Context, zoom: Boolean, private val onMessage: (RichPage.Msg) -> Unit) {
    val view = WebView(context)
    private var ready = false
    private var destroyed = false
    private var pending: String? = null

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
        }
        view.setBackgroundColor(Color.TRANSPARENT)
        view.isVerticalScrollBarEnabled = zoom
        view.isHorizontalScrollBarEnabled = zoom
        view.overScrollMode = View.OVER_SCROLL_NEVER
        // The card reads as "Mermaid diagram"; the SVG's text isn't the content.
        view.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        view.webViewClient = Client(loader)
        view.addJavascriptInterface(Bridge(), "OfficeBridge")
        view.loadUrl(PAGE)
    }

    /** Runs [script] now, or once the page is ready; a later one replaces one still waiting. */
    fun run(script: String) {
        if (destroyed) return
        if (ready) view.evaluateJavascript(script, null) else pending = script
    }

    fun destroy() {
        destroyed = true
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
            if (!destroyed) onMessage(RichPage.Msg.Drawn(-1, false, 0, null, "The page stopped"))
            return true
        }
    }

    private inner class Bridge {
        // Called on a WebView thread; the app handles it on the main thread.
        @JavascriptInterface
        fun post(json: String) {
            val msg = RichPage.decode(json) ?: return
            view.post {
                if (destroyed) return@post
                if (msg == RichPage.Msg.Ready) {
                    ready = true
                    pending?.let {
                        pending = null
                        view.evaluateJavascript(it, null)
                    }
                }
                onMessage(msg)
            }
        }
    }

    private class FontHandler(private val context: Context) : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            if (path != "geist.ttf") return null
            return WebResourceResponse("font/ttf", null, context.resources.openRawResource(R.font.geist))
        }
    }

    companion object {
        const val PAGE = "https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/richblock/index.html"

        fun refused() = WebResourceResponse("text/plain", "utf-8", 404, "Not found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }
}

/**
 * One drawing of [source] in its own rich block page. [cached] shows a drawing made before without
 * Mermaid. Drawn, it is as tall as the drawing ([fill] fills its space instead); until then it is
 * a line tall, under the source the card shows.
 */
@Composable
private fun DiagramView(source: String, cached: Drawing?, zoom: Boolean, modifier: Modifier, onDrawn: (Drawing) -> Unit, onFailed: () -> Unit) {
    val context = LocalContext.current
    val drawn = rememberUpdatedState(onDrawn)
    val failed = rememberUpdatedState(onFailed)
    val latest = remember { intArrayOf(0) }
    var height by remember { mutableIntStateOf(if (zoom) 0 else cached?.height ?: 0) }
    val page = remember {
        RichBlockPage(context, zoom) { msg ->
            if (msg !is RichPage.Msg.Drawn || (msg.id != latest[0] && msg.id != -1)) return@RichBlockPage
            val svg = msg.svg
            if (msg.ok && svg != null) {
                height = msg.height
                drawn.value(Drawing(svg, msg.height))
            } else {
                failed.value()
            }
        }
    }
    DisposableEffect(page) { onDispose { page.destroy() } }
    LaunchedEffect(page, source) {
        latest[0] += 1
        page.run(RichPage.draw(latest[0], RichPage.Kind.Mermaid, source, cached?.svg, zoom))
    }
    key(page) {
        AndroidView(factory = { page.view }, modifier = if (zoom) modifier else modifier.height(height.coerceAtLeast(1).dp))
    }
}

/**
 * A ```mermaid block in an assistant message: drawn offline as its diagram, with Source, Zoom and
 * Copy, as the web Thread's diagram card. It shows its source while the message streams, until it
 * draws, and when Mermaid can't draw it.
 */
@Composable
internal fun MermaidBlock(b: Markdown.Block.Code, streaming: Boolean, mono: FontFamily) {
    val source = remember(b.text) { b.text.trim() }
    var drawing by remember(source) { mutableStateOf(Drawings[source]) }
    var failed by remember(source) { mutableStateOf(false) }
    var showSource by rememberSaveable { mutableStateOf(false) }
    var zoomed by rememberSaveable { mutableStateOf(false) }
    val shape = RoundedCornerShape(4.dp)
    val shown = drawing
    Column(
        Modifier.fillMaxWidth().panel(shape, Palette.Surface, Palette.Border).tagged(Tags.Worker.THREAD_DIAGRAM)
            .semantics { if (shown != null && !showSource) contentDescription = "Mermaid diagram" },
    ) {
        DisableSelection {
            Row(
                Modifier.fillMaxWidth().background(Palette.SurfaceRaised).padding(start = 10.dp, end = 6.dp, top = 3.dp, bottom = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    "MERMAID",
                    style = LocalOfficeType.current.eyebrow.copy(color = Palette.TextSecondary),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (shown != null) {
                    HeaderChip(
                        if (showSource) "DIAGRAM" else "SOURCE",
                        null,
                        Modifier.toggleable(showSource, role = Role.Switch) { showSource = it }.tagged(Tags.Worker.THREAD_DIAGRAM_SOURCE),
                    )
                    HeaderChip("ZOOM", OfficeIcons.Expand, Modifier.clickable(role = Role.Button, onClickLabel = "Zoom the diagram") { zoomed = true }.tagged(Tags.Worker.THREAD_DIAGRAM_ZOOM))
                }
                CopyActionChip(label = "COPY", textToCopy = b.text, clipTitle = "Mermaid source", tag = Tags.Worker.THREAD_DIAGRAM_COPY)
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Border))
        if (source.isNotEmpty() && !streaming && !failed && !(showSource && shown != null)) {
            Box(Modifier.fillMaxWidth()) {
                DiagramView(
                    source, shown, zoom = false, Modifier.fillMaxWidth(),
                    onDrawn = {
                        Drawings[source] = it
                        drawing = it
                    },
                    onFailed = {
                        failed = true
                        drawing = null
                    },
                )
                // Taps open the diagram full screen, and drags scroll the Thread rather than the page.
                if (shown != null) Box(Modifier.matchParentSize().clickable(onClickLabel = "Zoom the diagram") { zoomed = true })
            }
        }
        if (shown == null || showSource || failed) CodeBody(b.text, "mermaid", mono)
    }
    if (zoomed && shown != null) DiagramViewer(source, shown, b.text) { zoomed = false }
}

@Composable
private fun HeaderChip(label: String, icon: ImageVector?, modifier: Modifier) {
    Row(
        Modifier.clip(RoundedCornerShape(3.dp)).then(modifier).heightIn(min = 28.dp).padding(horizontal = 7.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        if (icon != null) Icon(icon, null, tint = Palette.TextSecondary, modifier = Modifier.size(12.dp))
        Text(label, style = LocalOfficeType.current.eyebrow.copy(color = Palette.TextSecondary), maxLines = 1)
    }
}

/** A diagram full screen, pinch to zoom, with its source to copy. */
@Composable
private fun DiagramViewer(source: String, drawing: Drawing, raw: String, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        var failed by remember { mutableStateOf(false) }
        Column(Modifier.fillMaxSize().background(Palette.Bg).systemBarsPadding().tagged(Tags.Worker.THREAD_DIAGRAM_VIEWER)) {
            Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Mermaid diagram", style = MaterialTheme.typography.titleSmall, color = Palette.Text, modifier = Modifier.weight(1f))
                CopyActionChip(label = "COPY SOURCE", textToCopy = raw, clipTitle = "Mermaid source", tag = Tags.Worker.THREAD_DIAGRAM_COPY)
                IconButton(onClick = onClose, modifier = Modifier.tagged(Tags.Worker.THREAD_DIAGRAM_VIEWER_CLOSE)) {
                    Icon(Icons.Filled.Close, contentDescription = "Close the diagram", tint = Palette.Text)
                }
            }
            if (failed) CodeBody(raw, "mermaid", LocalOfficeType.current.mono)
            else DiagramView(source, drawing, zoom = true, Modifier.weight(1f).fillMaxWidth().semantics { contentDescription = "Mermaid diagram" }, onDrawn = {}, onFailed = { failed = true })
        }
    }
}
