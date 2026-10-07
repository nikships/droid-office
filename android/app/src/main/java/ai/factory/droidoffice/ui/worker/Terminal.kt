package ai.factory.droidoffice.ui.worker

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.factory.droidoffice.core.Run
import ai.factory.droidoffice.core.ScreenState
import ai.factory.droidoffice.core.TermPalette
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.Palette
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

private val TermBg = Color(TermPalette.BACKGROUND)
// The office's own terminal window uses 1.1 (src/client/ui/terminal.ts).
private const val LINE = 1.1f
private const val READABLE_SP = 12.5f
private const val MAX_SP = 24f

fun rowText(runs: List<Run>): AnnotatedString = buildAnnotatedString {
    for (r in runs) {
        val s = TermPalette.style(r)
        withStyle(
            SpanStyle(
                color = Color(s.fg),
                background = s.bg?.let { Color(it) } ?: Color.Unspecified,
                fontWeight = if (s.bold) FontWeight.Bold else null,
            ),
        ) { append(r.text) }
    }
}

/**
 * A worker's terminal as the office draws it on the laptop: the PTY's grid at its own size, fit to
 * the phone's width to start with. Pinch zooms (and the grid scrolls both ways once it's bigger than
 * the view), a double tap flips between fit and readable, and the view follows the bottom of the
 * screen, where TUIs keep their input, until the owner scrolls up.
 */
@Composable
fun Terminal(screen: ScreenState?, live: Boolean, modifier: Modifier = Modifier) {
    val family = LocalOfficeType.current.terminal
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    // Advance of one cell in px at 100sp; every size below scales from it.
    val cellAt100 = remember(family, density) {
        measurer.measure("M".repeat(100), TextStyle(fontFamily = family, fontSize = 100.sp)).size.width / 100f
    }
    var zoom by remember { mutableFloatStateOf(1f) }
    var follow by remember { mutableStateOf(true) }
    val vScroll = rememberScrollState()
    val hScroll = rememberScrollState()
    val scope = rememberCoroutineScope()

    BoxWithConstraints(modifier.clip(RoundedCornerShape(12.dp)).background(TermBg)) {
        if (screen == null) {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Spinner(Modifier.size(22.dp))
                Spacer(Modifier.height(10.dp))
                Text("Opening the terminal…", style = MaterialTheme.typography.bodySmall)
            }
            return@BoxWithConstraints
        }
        val pad = with(density) { 8.dp.toPx() }
        val viewW = constraints.maxWidth - pad * 2
        // Half a cell spare, so rounding in the text layout never pushes the last column out of view.
        val fitSp = (viewW / (screen.cols + 0.5f) / cellAt100 * 100f).coerceIn(3f, MAX_SP)
        val maxZoom = (MAX_SP / fitSp).coerceAtLeast(1f)
        val readable = (READABLE_SP / fitSp).coerceIn(1f, maxZoom)
        val fontSp = fitSp * zoom.coerceIn(1f, maxZoom)
        val cellW = cellAt100 * fontSp / 100f
        val lineH = with(density) { (fontSp * LINE).sp.toPx() }
        val gridW = cellW * (screen.cols + 0.5f)
        val gridH = lineH * screen.rows
        val style = remember(family, fontSp) {
            TextStyle(
                fontFamily = family,
                fontSize = fontSp.sp,
                lineHeight = (fontSp * LINE).sp,
                color = Color(TermPalette.FOREGROUND),
                lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None),
            )
        }

        val transform = rememberTransformableState { _, change, _, _ -> zoom = (zoom * change).coerceIn(1f, maxZoom) }

        // Stick to the bottom as frames arrive, unless the owner has scrolled up to read.
        LaunchedEffect(screen.version, follow, gridH) {
            if (follow) vScroll.scrollTo(vScroll.maxValue)
        }
        LaunchedEffect(vScroll) {
            snapshotFlow { vScroll.isScrollInProgress to (vScroll.maxValue - vScroll.value) }.collect { (moving, fromBottom) ->
                if (moving) follow = fromBottom < lineH * 1.5f
            }
        }

        Box(
            Modifier.fillMaxSize()
                .transformable(transform, canPan = { false })
                .pointerInput(maxZoom, readable) {
                    detectTapGestures(onDoubleTap = { zoom = if (zoom > 1.05f) 1f else readable })
                }
                .verticalScroll(vScroll)
                .horizontalScroll(hScroll)
                .padding(8.dp),
        ) {
            val wDp = with(density) { gridW.toDp() }
            val hDp = with(density) { gridH.toDp() }
            Box(Modifier.requiredSize(wDp, hDp)) {
                Column {
                    screen.lines.forEachIndexed { i, row ->
                        key(i) {
                            val text = remember(row) { rowText(row) }
                            Text(text, style = style, softWrap = false, maxLines = 1, modifier = Modifier.height(with(density) { lineH.toDp() }))
                        }
                    }
                }
                if (live && screen.cursorY in 0 until screen.rows) Cursor(screen.cursorX * cellW, screen.cursorY * lineH, cellW, lineH)
            }
        }

        AnimatedVisibility(!follow, Modifier.align(Alignment.BottomCenter).padding(bottom = 10.dp), enter = fadeIn(), exit = fadeOut()) {
            Row(
                Modifier.clip(RoundedCornerShape(50)).background(Palette.SurfaceHigh).clickable {
                    follow = true
                    scope.launch { vScroll.animateScrollTo(vScroll.maxValue) }
                }.padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Default.KeyboardArrowDown, null, Modifier.size(16.dp), tint = Palette.Text)
                Spacer(Modifier.width(4.dp))
                Text("Latest", style = MaterialTheme.typography.labelMedium)
            }
        }
        if (maxZoom > 1.05f) {
            val zoomed = zoom > 1.01f
            Row(
                Modifier.align(Alignment.TopEnd).padding(6.dp).clip(RoundedCornerShape(6.dp)).background(Color(0xD9151515))
                    .border(1.dp, Palette.BorderStrong, RoundedCornerShape(6.dp))
                    .clickable { zoom = if (zoomed) 1f else readable }
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(if (zoomed) "FIT" else "Aa", style = LocalOfficeType.current.eyebrow.copy(fontSize = 10.sp, color = Palette.Text))
                if (zoomed) Text(" · ${fontSp.roundToInt()}PT", style = LocalOfficeType.current.eyebrow.copy(fontSize = 10.sp))
            }
        }
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
