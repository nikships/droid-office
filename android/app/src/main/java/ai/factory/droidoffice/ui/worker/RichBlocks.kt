package ai.factory.droidoffice.ui.worker

import androidx.collection.LruCache
import ai.factory.droidoffice.core.Markdown
import ai.factory.droidoffice.core.RichPage
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import ai.factory.droidoffice.ui.theme.ThreadPalette
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import kotlinx.coroutines.launch
import kotlinx.coroutines.CancellationException

/** What the page drew: a diagram's sanitized SVG (null for an equation), and the height (dp) it took at the Thread's width. */
private data class Drawing(val svg: String?, val height: Int)

/**
 * Drawings by kind and source, so a block scrolled back into view, switched back from its source
 * or opened full screen shows again at its size, and a diagram without Mermaid. Touched only on the main thread.
 */
private object Drawings {
    private val cache = LruCache<String, Drawing>(64)

    private fun key(kind: RichPage.Kind, source: String) = "${kind.wire}/$source"

    operator fun get(kind: RichPage.Kind, source: String): Drawing? = cache[key(kind, source)]

    operator fun set(kind: RichPage.Kind, source: String, d: Drawing) {
        cache.put(key(kind, source), d)
    }
}

/** A drawing may be requested before its module has loaded. Only the latest request is relevant. */
internal abstract class RichBlockPage(private val onMessage: (RichPage.Msg) -> Unit) {
    var onZoom: ((Int) -> Unit)? = null
    private var ready = false
    private var destroyed = false
    private var pending: String? = null

    protected fun received(msg: RichPage.Msg) {
        if (destroyed) return
        if (msg == RichPage.Msg.Ready) {
            ready = true
            pending?.let {
                pending = null
                evaluate(it)
            }
        }
        onMessage(msg)
    }

    /** Runs [script] now, or once the page is ready; a later one replaces one still waiting. */
    fun run(script: String) {
        if (destroyed) return
        if (ready) evaluate(script) else pending = script
    }

    fun destroy() {
        destroyed = true
        ready = false
        pending = null
        onZoom = null
        disposeView()
    }

    protected abstract fun evaluate(script: String)
    protected abstract fun disposeView()
    abstract fun changeZoom(inward: Boolean)
    @Composable abstract fun Surface(modifier: Modifier)
}

/**
 * One drawing of [source] in its own rich block page. [cached] shows a diagram drawn before without
 * Mermaid. Drawn, it is as tall as the drawing ([zoom] fills its space instead); until then it is
 * a line tall, under the text the block shows meanwhile.
 */
@Composable
private fun RichView(kind: RichPage.Kind, source: String, cached: Drawing?, zoom: Boolean, modifier: Modifier, onDrawn: (Drawing) -> Unit, onFailed: () -> Unit, onPage: ((RichBlockPage) -> Unit)? = null) {
    val drawn = rememberUpdatedState(onDrawn)
    val failed = rememberUpdatedState(onFailed)
    val latest = remember { intArrayOf(0) }
    var height by remember { mutableIntStateOf(if (zoom) 0 else cached?.height ?: 0) }
    val page = rememberRichPage(zoom) { msg ->
        if (msg !is RichPage.Msg.Drawn || (msg.id != latest[0] && msg.id != -1)) return@rememberRichPage
        val svg = msg.svg
        if (msg.ok && (svg != null || kind != RichPage.Kind.Mermaid)) {
            height = msg.height
            drawn.value(Drawing(svg, msg.height))
        } else {
            failed.value()
        }
    }
    DisposableEffect(page) { onDispose { page.destroy() } }
    LaunchedEffect(page, onPage) { onPage?.invoke(page) }
    LaunchedEffect(page, source) {
        latest[0] += 1
        page.run(RichPage.draw(latest[0], kind, source, cached?.svg, zoom))
    }
    key(page) {
        page.Surface(if (zoom) modifier else modifier.height(height.coerceAtLeast(1).dp))
    }
}

/**
 * A ```mermaid block in an assistant message: drawn offline as its diagram. An unfinished fence is
 * only a quiet placeholder; a drawing opens full screen, and its overflow carries source actions.
 */
@Composable
internal fun MermaidBlock(b: Markdown.Block.Code, streaming: Boolean, mono: FontFamily) {
    val source = remember(b.text) { b.text.trim() }
    var drawing by remember(source) { mutableStateOf(Drawings[RichPage.Kind.Mermaid, source]) }
    var failed by remember(source) { mutableStateOf(false) }
    var showSource by rememberSaveable { mutableStateOf(false) }
    var zoomed by rememberSaveable { mutableStateOf(false) }
    var actions by remember { mutableStateOf(false) }
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val share = rememberSvgShare()
    val shape = RoundedCornerShape(4.dp)
    val snackbar = LocalSnackbar.current
    val shown = drawing
    val download = rememberThreadDownload("diagram.svg", "image/svg+xml") { drawing?.svg?.encodeToByteArray() }
    val mode = RichPage.mermaidMode(b, streaming, showSource, failed)
    Column(
        Modifier.fillMaxWidth().panel(shape, ThreadPalette.Surface, ThreadPalette.BorderStrong).tagged(Tags.Worker.THREAD_DIAGRAM)
            .semantics { if (shown != null && !showSource) contentDescription = "Mermaid diagram" },
    ) {
        if (source.isNotEmpty() && mode == RichPage.MermaidMode.Drawing) {
            Box(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                RichView(
                    RichPage.Kind.Mermaid, source, shown, zoom = false, Modifier.fillMaxWidth(),
                    onDrawn = {
                        Drawings[RichPage.Kind.Mermaid, source] = it
                        drawing = it
                    },
                    onFailed = {
                        failed = true
                        drawing = null
                    },
                )
                if (shown == null) {
                    Box(Modifier.fillMaxWidth().height(80.dp), contentAlignment = Alignment.Center) {
                        Spinner(Modifier.size(24.dp), ThreadPalette.TextSecondary)
                    }
                } else {
                    Box(Modifier.matchParentSize().clickable(onClickLabel = "Zoom the diagram") { zoomed = true }.tagged(Tags.Worker.THREAD_DIAGRAM_ZOOM))
                    Box(Modifier.align(Alignment.TopEnd).padding(8.dp)) {
                        IconButton(onClick = { actions = true }, modifier = Modifier.size(28.dp)) {
                            Icon(ToolIcons.MoreHorizontal, "Mermaid diagram actions", tint = ThreadPalette.TextTertiary, modifier = Modifier.size(16.dp))
                        }
                        DropdownMenu(expanded = actions, onDismissRequest = { actions = false }) {
                            DropdownMenuItem(
                                text = { Text(if (showSource) "Show diagram" else "Show source") },
                                onClick = { actions = false },
                                modifier = Modifier.toggleable(showSource, role = Role.Switch) { showSource = it; actions = false }.tagged(Tags.Worker.THREAD_DIAGRAM_SOURCE),
                            )
                            DropdownMenuItem(
                                text = { Text("Copy Mermaid code") },
                                onClick = {
                                    actions = false
                                    scope.launch { clipboard.setClipEntry(workerTextClip("Mermaid source", b.text)) }
                                },
                                modifier = Modifier.tagged(Tags.Worker.THREAD_DIAGRAM_COPY),
                            )
                            DropdownMenuItem(
                                text = { Text("Download as SVG") },
                                enabled = shown.svg != null,
                                onClick = { actions = false; download() },
                                modifier = Modifier.tagged(Tags.Worker.THREAD_DIAGRAM_DOWNLOAD),
                            )
                            DropdownMenuItem(
                                text = { Text("Share SVG") },
                                enabled = shown.svg != null,
                                onClick = {
                                    actions = false
                                    val svg = shown.svg ?: return@DropdownMenuItem
                                    scope.launch {
                                        try {
                                            share(svg)
                                        } catch (cancelled: CancellationException) {
                                            throw cancelled
                                        } catch (_: Exception) {
                                            snackbar.showSnackbar("Couldn't share this diagram")
                                        }
                                    }
                                },
                                modifier = Modifier.tagged(Tags.Worker.THREAD_DIAGRAM_SHARE),
                            )
                        }
                    }
                }
            }
        } else if (mode == RichPage.MermaidMode.Pending) {
            Box(
                Modifier.fillMaxWidth().height(80.dp).semantics { contentDescription = "Rendering diagram" },
                contentAlignment = Alignment.Center,
            ) {
                Spinner(Modifier.size(24.dp), ThreadPalette.TextSecondary)
            }
        }
        if (mode == RichPage.MermaidMode.Source) CodeBody(b.text, "mermaid", mono, wrap = true, background = ThreadPalette.Surface)
    }
    if (zoomed && shown != null) DiagramViewer(source, shown, b.text) { zoomed = false }
}
/** A diagram full screen, pinch to zoom, with explicit zoom controls and its source to copy. */
@Composable
private fun DiagramViewer(source: String, drawing: Drawing, raw: String, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = workerDialogProperties()) {
        var failed by remember { mutableStateOf(false) }
        var page by remember { mutableStateOf<RichBlockPage?>(null) }
        var reset by remember { mutableIntStateOf(0) }
        var zoomPercent by remember { mutableIntStateOf(100) }
        Column(Modifier.fillMaxSize().background(Palette.Bg).systemBarsPadding().tagged(Tags.Worker.THREAD_DIAGRAM_VIEWER)) {
            Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Mermaid diagram", style = MaterialTheme.typography.titleSmall, color = Palette.Text, modifier = Modifier.weight(1f))
                CopyActionChip(label = "COPY SOURCE", textToCopy = raw, clipTitle = "Mermaid source", tag = Tags.Worker.THREAD_DIAGRAM_COPY)
                IconButton(onClick = onClose, modifier = Modifier.tagged(Tags.Worker.THREAD_DIAGRAM_VIEWER_CLOSE)) {
                    Icon(Icons.Filled.Close, contentDescription = "Close the diagram", tint = Palette.Text)
                }
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                if (failed) CodeBody(raw, "mermaid", LocalOfficeType.current.mono)
                else key(reset) {
                    RichView(
                        RichPage.Kind.Mermaid,
                        source,
                        drawing,
                        zoom = true,
                        Modifier.fillMaxSize().semantics { contentDescription = "Mermaid diagram" },
                        onDrawn = {},
                        onFailed = { failed = true },
                        onPage = { next -> page = next; next.onZoom = { zoomPercent = it } },
                    )
                }
                Row(
                    Modifier.align(Alignment.BottomCenter).padding(bottom = 24.dp)
                        .background(Palette.Surface, RoundedCornerShape(4.dp))
                        .border(1.dp, Palette.Border, RoundedCornerShape(4.dp))
                        .padding(horizontal = 8.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = { page?.changeZoom(false) }, enabled = !failed && zoomPercent > 25) {
                        Icon(OfficeIcons.Minus, "Zoom out", tint = Palette.TextSecondary)
                    }
                    Text("$zoomPercent%", style = LocalOfficeType.current.monoBody.copy(color = Palette.TextSecondary), modifier = Modifier.width(52.dp), textAlign = TextAlign.Center)
                    IconButton(onClick = { page?.changeZoom(true) }, enabled = !failed && zoomPercent < 400) {
                        Icon(OfficeIcons.Plus, "Zoom in", tint = Palette.TextSecondary)
                    }
                    IconButton(onClick = {
                        zoomPercent = 100
                        failed = false
                        reset++
                    }) {
                        Icon(OfficeIcons.Retry, "Reset diagram view", tint = Palette.TextSecondary)
                    }
                }
            }
        }
    }
}
/**
 * A `$$…$$` equation on its own line in an assistant message: typeset offline by KaTeX in the rich
 * block page, centred, shrunk to fit the width. Until it draws, and when KaTeX can't draw it, the
 * equation shows as text ([mathText]), or as its TeX when even that can't lay it out.
 */
@Composable
internal fun MathBlock(b: Markdown.Block.Math, style: TextStyle) {
    var drawing by remember(b.tex) { mutableStateOf(Drawings[RichPage.Kind.Math, b.tex]) }
    var failed by remember(b.tex) { mutableStateOf(false) }
    val fallback = remember(b.tex) { mathText(b.tex) }
    Box(
        Modifier.fillMaxWidth().tagged(Tags.Worker.THREAD_MATH).semantics { contentDescription = b.tex },
        contentAlignment = Alignment.Center,
    ) {
        if (!failed) {
            RichView(
                RichPage.Kind.Math, b.tex, drawing, zoom = false, Modifier.fillMaxWidth(),
                onDrawn = {
                    Drawings[RichPage.Kind.Math, b.tex] = it
                    drawing = it
                },
                onFailed = { failed = true },
            )
            // Drags on the equation scroll the Thread rather than the page.
            Box(Modifier.matchParentSize().pointerInput(Unit) {})
        }
        if (failed || drawing == null) {
            Text(
                fallback ?: AnnotatedString(b.raw),
                style = style.copy(textAlign = TextAlign.Center),
                modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
            )
        }
    }
}
