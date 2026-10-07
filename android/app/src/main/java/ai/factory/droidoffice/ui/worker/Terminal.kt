package ai.factory.droidoffice.ui.worker

import android.graphics.Paint
import android.graphics.Path
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.graphics.withClip
import androidx.core.graphics.withScale
import ai.factory.droidoffice.core.BoxGlyph
import ai.factory.droidoffice.core.Run
import ai.factory.droidoffice.core.ScreenState
import ai.factory.droidoffice.core.Span
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.TermLayout
import ai.factory.droidoffice.core.TermPalette
import ai.factory.droidoffice.core.TermSize
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.Palette
import ai.factory.droidoffice.ui.theme.TerminalFaces
import kotlinx.coroutines.launch
import java.util.IdentityHashMap
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

private val TermBg = Color(TermPalette.BACKGROUND)
// The office's own terminal window uses 1.1 (src/client/ui/terminal.ts).
private const val LINE = 1.1f
private const val READABLE_SP = 12.5f
private const val MAX_SP = 24f

/** How far the terminal is zoomed, kept outside it so the quick keys can flip between fit and readable. */
@Stable
class TerminalZoom(initial: Float = 1f) {
    var zoom by mutableFloatStateOf(initial)
    internal var max by mutableFloatStateOf(1f)
    internal var readable by mutableFloatStateOf(1f)

    val zoomable: Boolean get() = max > 1.05f
    val zoomed: Boolean get() = zoom > 1.01f

    fun toggle() {
        zoom = if (zoomed) 1f else readable
    }

    companion object {
        val Saver = Saver<TerminalZoom, Float>({ it.zoom }, { TerminalZoom(it) })
    }
}

@Composable
fun rememberTerminalZoom(key: String): TerminalZoom = rememberSaveable(key, saver = TerminalZoom.Saver) { TerminalZoom() }

/** Lays rows out once and reuses a row's spans for as long as the office keeps sending the same row. */
private class RowCache {
    private var rows = IdentityHashMap<List<Run>, List<Span>>()

    fun layout(lines: List<List<Run>>): List<List<Span>> {
        val next = IdentityHashMap<List<Run>, List<Span>>(lines.size)
        val out = lines.map { row -> next.getOrPut(row) { rows[row] ?: TermLayout.spans(row) } }
        rows = next
        return out
    }
}

private class Paints(faces: TerminalFaces) {
    val text = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG or Paint.LINEAR_TEXT_FLAG).apply { typeface = faces.regular }
    val fill = Paint()
    val smooth = Paint(Paint.ANTI_ALIAS_FLAG)
    val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.BUTT
    }
    val path = Path()

    /** Advance of one cell per px of text size; Geist Mono's is the same at every weight. */
    val advance: Float = Paint(text).apply { textSize = 100f }.measureText("M") / 100f
}

/**
 * A worker's terminal as the office draws it on the laptop: the PTY's grid at its own size, fit to
 * the phone's width to start with. Pinch zooms and a double tap flips between fit and readable.
 * Phone mode keeps readable text and measures a grid for the real PTY to adopt instead.
 * The view follows what the program last drew until the owner scrolls away.
 *
 * Cells are drawn straight onto a canvas, column by column: a wide or fallback glyph is fitted to
 * its cells so the rest of the row stays in line, and box drawing and block elements are shapes
 * that meet across rows.
 */
@Composable
fun Terminal(
    screen: ScreenState?,
    live: Boolean,
    zoom: TerminalZoom,
    modifier: Modifier = Modifier,
    phone: Boolean = false,
    onPhoneSize: (TermSize?) -> Unit = {},
) {
    val faces = LocalOfficeType.current.terminal
    val density = LocalDensity.current
    val paints = remember(faces) { Paints(faces) }
    val cache = remember { RowCache() }
    var follow by remember { mutableStateOf(true) }
    var followTarget by remember { mutableFloatStateOf(0f) }
    val vScroll = rememberScrollState()
    val hScroll = rememberScrollState()
    val scope = rememberCoroutineScope()

    BoxWithConstraints(
        modifier.clip(RoundedCornerShape(12.dp)).background(TermBg)
            .tagged(Tags.Worker.TERMINAL)
            .semantics {
                // TalkBack speaks the description; the whole screen is the node's text, so a
                // `uiautomator dump` reads the terminal without a screenshot.
                contentDescription = "Terminal: " + (screen?.lastLine() ?: "nothing on it yet")
                if (screen != null) text = AnnotatedString(screen.text())
            },
    ) {
        val pad = with(density) { 8.dp.toPx() }
        val viewW = constraints.maxWidth - pad * 2
        val viewH = constraints.maxHeight.toFloat()
        val readablePx = with(density) { READABLE_SP.sp.toPx() }
        val nativeLineH = (readablePx * LINE).roundToInt().toFloat().coerceAtLeast(1f)
        val phoneSize = TermSize.fit(viewW, viewH - pad * 2, paints.advance * readablePx, nativeLineH)
        SideEffect { onPhoneSize(phoneSize) }
        if (screen == null) {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Spinner(Modifier.size(22.dp))
                Spacer(Modifier.height(10.dp))
                Text("Opening the terminal…", style = MaterialTheme.typography.bodySmall)
            }
            return@BoxWithConstraints
        }
        val maxPx = with(density) { MAX_SP.sp.toPx() }
        // Half a cell spare, so rounding never pushes the last column out of view.
        val fitPx = (viewW / (screen.cols + 0.5f) / paints.advance).coerceIn(3f, maxPx)
        val maxZoom = (maxPx / fitPx).coerceAtLeast(1f)
        val readable = (readablePx / fitPx).coerceIn(1f, maxZoom)
        SideEffect {
            zoom.max = maxZoom
            zoom.readable = readable
        }
        val textPx = if (phone) readablePx else fitPx * zoom.zoom.coerceIn(1f, maxZoom)
        val cellW = paints.advance * textPx
        val lineH = (textPx * LINE).roundToInt().toFloat().coerceAtLeast(1f)
        val gridW = cellW * (screen.cols + 0.5f)
        val gridH = lineH * screen.rows
        val rows = remember(screen) { cache.layout(screen.lines) }
        val cursor = live && TermLayout.cursorShown(screen)
        val focus = TermLayout.focusRow(screen)

        val transform = rememberTransformableState { _, change, _, _ -> zoom.zoom = (zoom.zoom * change).coerceIn(1f, maxZoom) }

        // Keep what the program last drew (or the cursor) in sight as frames arrive, unless the owner
        // has scrolled away to read; a zoomed-in grid's empty bottom rows are not worth following.
        LaunchedEffect(screen.version, follow, lineH, viewH) {
            followTarget = (pad * 2 + (focus + 1.5f) * lineH - viewH).coerceIn(0f, vScroll.maxValue.toFloat())
            if (follow) vScroll.scrollTo(followTarget.roundToInt())
        }
        LaunchedEffect(vScroll) {
            snapshotFlow { vScroll.isScrollInProgress to vScroll.value }.collect { (moving, value) ->
                if (moving) follow = value >= followTarget - lineH * 1.5f
            }
        }

        Box(
            Modifier.fillMaxSize()
                .transformable(transform, canPan = { false }, enabled = !phone)
                .pointerInput(zoom, phone) { if (!phone) detectTapGestures(onDoubleTap = { zoom.toggle() }) }
                .verticalScroll(vScroll)
                .horizontalScroll(hScroll)
                .padding(8.dp),
        ) {
            val wDp = with(density) { gridW.toDp() }
            val hDp = with(density) { gridH.toDp() }
            Box(Modifier.requiredSize(wDp, hDp)) {
                Canvas(Modifier.requiredSize(wDp, hDp)) {
                    val c = drawContext.canvas.nativeCanvas
                    paints.text.textSize = textPx
                    val fm = paints.text.fontMetrics
                    val baseline = (lineH - (fm.descent - fm.ascent)) / 2f - fm.ascent
                    rows.forEachIndexed { y, spans -> drawRow(c, paints, faces, spans, y * lineH, cellW, lineH, baseline) }
                }
                if (cursor) Cursor(screen.cursorX * cellW, screen.cursorY * lineH, cellW, lineH)
            }
        }

        AnimatedVisibility(!follow, Modifier.align(Alignment.BottomCenter).padding(bottom = 10.dp), enter = fadeIn(), exit = fadeOut()) {
            Row(
                Modifier.clip(RoundedCornerShape(50)).background(Palette.SurfaceHigh).clickable {
                    follow = true
                    scope.launch { vScroll.animateScrollTo(followTarget.roundToInt()) }
                }.tagged(Tags.Worker.LATEST).padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Default.KeyboardArrowDown, null, Modifier.size(16.dp), tint = Palette.Text)
                Spacer(Modifier.width(4.dp))
                Text("Latest", style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}

private fun drawRow(c: android.graphics.Canvas, p: Paints, faces: TerminalFaces, spans: List<Span>, top: Float, cellW: Float, lineH: Float, baseline: Float) {
    val y0 = top.roundToInt().toFloat()
    val y1 = (top + lineH).roundToInt().toFloat()
    for (s in spans) {
        val bg = s.style.bg ?: continue
        p.fill.color = bg
        c.drawRect((s.col * cellW).roundToInt().toFloat(), y0, ((s.col + s.width) * cellW).roundToInt().toFloat(), y1, p.fill)
    }
    for (s in spans) {
        val x = s.col * cellW
        val w = s.width * cellW
        val box = s.box
        if (box != null) {
            drawBox(c, p, box, x, top, w, lineH, s.style.fg)
            continue
        }
        if (s.text.isBlank()) continue
        val text = p.text
        text.color = s.style.fg
        text.typeface = if (s.style.bold) faces.bold else faces.regular
        val measured = text.measureText(s.text)
        val y = top + baseline
        if (s.simple && abs(measured - w) < 0.5f) {
            c.drawText(s.text, x, y, text)
        } else if (measured > w || s.simple) {
            // Squeeze it into its columns rather than let it push the rest of the row out of line.
            c.withScale(w / measured, 1f, x, y) { c.drawText(s.text, x, y, text) }
        } else {
            c.drawText(s.text, x + (w - measured) / 2f, y, text)
        }
    }
}

private fun drawBox(c: android.graphics.Canvas, p: Paints, g: BoxGlyph, x: Float, top: Float, w: Float, h: Float, color: Int) {
    val x0 = x.roundToInt().toFloat()
    val x1 = (x + w).roundToInt().toFloat()
    val y0 = top.roundToInt().toFloat()
    val y1 = (top + h).roundToInt().toFloat()
    val cx = ((x0 + x1) / 2f).toInt().toFloat()
    val cy = ((y0 + y1) / 2f).toInt().toFloat()
    val light = max(1f, (w / 8f).roundToInt().toFloat())
    val heavy = max(light + 1f, light * 2f)
    p.fill.color = color
    p.stroke.color = color
    p.smooth.color = color
    when (g) {
        is BoxGlyph.Lines -> {
            fun thickness(weight: Int) = when (weight) {
                BoxGlyph.HEAVY -> heavy
                BoxGlyph.DOUBLE -> light * 3f
                BoxGlyph.LIGHT -> light
                else -> 0f
            }
            // Each arm starts far enough back to cover the widest arm across it, so joints are solid.
            val across = max(thickness(g.up), thickness(g.down))
            val along = max(thickness(g.left), thickness(g.right))
            fun hArm(weight: Int, from: Float, to: Float) {
                if (weight == BoxGlyph.NONE) return
                val l = min(from, to)
                val r = max(from, to)
                if (weight == BoxGlyph.DOUBLE) {
                    c.drawRect(l, cy - light * 1.5f, r, cy - light * 0.5f, p.fill)
                    c.drawRect(l, cy + light * 0.5f, r, cy + light * 1.5f, p.fill)
                } else {
                    val t = thickness(weight)
                    val a = cy - (t / 2f).toInt()
                    c.drawRect(l, a, r, a + t, p.fill)
                }
            }
            fun vArm(weight: Int, from: Float, to: Float) {
                if (weight == BoxGlyph.NONE) return
                val t0 = min(from, to)
                val b = max(from, to)
                if (weight == BoxGlyph.DOUBLE) {
                    c.drawRect(cx - light * 1.5f, t0, cx - light * 0.5f, b, p.fill)
                    c.drawRect(cx + light * 0.5f, t0, cx + light * 1.5f, b, p.fill)
                } else {
                    val t = thickness(weight)
                    val a = cx - (t / 2f).toInt()
                    c.drawRect(a, t0, a + t, b, p.fill)
                }
            }
            hArm(g.left, x0, cx + across / 2f)
            hArm(g.right, cx - across / 2f, x1)
            vArm(g.up, y0, cy + along / 2f)
            vArm(g.down, cy - along / 2f, y1)
        }
        is BoxGlyph.Arc -> {
            val r = min(x1 - x0, y1 - y0) / 2f
            val ye = if (g.down) y1 else y0
            val xe = if (g.right) x1 else x0
            val sv = if (g.down) 1f else -1f
            val sh = if (g.right) 1f else -1f
            // The centre of a light line as Lines draws it, so arcs meet the straight runs.
            val mx = cx - (light / 2f).toInt() + light / 2f
            val my = cy - (light / 2f).toInt() + light / 2f
            p.stroke.strokeWidth = light
            p.path.reset()
            p.path.moveTo(mx, ye)
            p.path.lineTo(mx, my + sv * r)
            p.path.quadTo(mx, my, mx + sh * r, my)
            p.path.lineTo(xe, my)
            c.drawPath(p.path, p.stroke)
        }
        is BoxGlyph.Diagonal -> {
            p.stroke.strokeWidth = light
            c.withClip(x0, y0, x1, y1) {
                if (g.rising) c.drawLine(x0, y1, x1, y0, p.stroke)
                if (g.falling) c.drawLine(x0, y0, x1, y1, p.stroke)
            }
        }
        is BoxGlyph.Blocks -> {
            if (g.alpha < 1f) p.fill.alpha = (p.fill.alpha * g.alpha).roundToInt()
            for (r in g.rects) {
                c.drawRect(
                    (x0 + r[0] * (x1 - x0)).roundToInt().toFloat(), (y0 + r[1] * (y1 - y0)).roundToInt().toFloat(),
                    (x0 + r[2] * (x1 - x0)).roundToInt().toFloat(), (y0 + r[3] * (y1 - y0)).roundToInt().toFloat(),
                    p.fill,
                )
            }
        }
        is BoxGlyph.Powerline -> {
            val mid = (y0 + y1) / 2f
            val (base, tip) = if (g.right) x0 to x1 else x1 to x0
            p.path.reset()
            p.path.moveTo(base, y0)
            p.path.lineTo(tip, mid)
            p.path.lineTo(base, y1)
            if (g.solid) {
                p.path.close()
                c.drawPath(p.path, p.smooth)
            } else {
                p.stroke.strokeWidth = light
                c.drawPath(p.path, p.stroke)
            }
        }
        BoxGlyph.Dot -> c.drawCircle((x0 + x1) / 2f, (y0 + y1) / 2f, min(x1 - x0, y1 - y0) * 0.34f, p.smooth)
    }
}

@Composable
private fun Cursor(x: Float, y: Float, w: Float, h: Float) {
    val density = LocalDensity.current
    val blink by rememberInfiniteTransition(label = "cursor").animateFloat(
        0.85f, 0.15f, infiniteRepeatable(tween(560, easing = LinearEasing), RepeatMode.Reverse), label = "cursor",
    )
    Box(
        Modifier.offset { IntOffset(x.roundToInt(), y.roundToInt()) }
            .size(with(density) { w.coerceAtLeast(2f).toDp() }, with(density) { h.toDp() })
            .graphicsLayer { alpha = blink }
            .background(Color(TermPalette.CURSOR)),
    )
}
