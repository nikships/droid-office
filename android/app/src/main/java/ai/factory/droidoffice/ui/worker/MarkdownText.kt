package ai.factory.droidoffice.ui.worker

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Constraints
import ai.factory.droidoffice.ui.theme.OfficeIcons
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import ai.factory.droidoffice.core.Markdown
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.Palette

/** A message's Markdown, laid out with the office's type. Links open in the browser. */
@Composable
internal fun MarkdownText(source: String, modifier: Modifier = Modifier, compact: Boolean = false) {
    val blocks = remember(source) { Markdown.parse(source) }
    val mono = LocalOfficeType.current.mono
    val body = if (compact) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp, lineHeight = 22.sp)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(if (compact) 3.dp else 8.dp)) {
        for (b in blocks) {
            when (b) {
                is Markdown.Block.Heading -> Text(
                    styled(b.spans, mono),
                    style = when (b.level) {
                        1 -> MaterialTheme.typography.titleLarge
                        2 -> MaterialTheme.typography.titleMedium
                        else -> MaterialTheme.typography.titleSmall
                    },
                )
                is Markdown.Block.Paragraph -> Text(styled(b.spans, mono), style = body)
                is Markdown.Block.Item -> Row(Modifier.padding(start = (b.depth * 14).dp)) {
                    val marker = when (b.checked) {
                        true -> "☑"
                        false -> "☐"
                        null -> b.marker
                    }
                    Text(marker, style = body.copy(color = if (b.checked == true) Palette.Success else Palette.TextSecondary), modifier = Modifier.width(if (b.marker.length > 2) 30.dp else 20.dp))
                    Text(
                        styled(b.spans, mono),
                        style = if (b.checked == true) body.copy(color = Palette.TextSecondary, textDecoration = TextDecoration.LineThrough) else body,
                    )
                }
                is Markdown.Block.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
                    Box(Modifier.width(2.dp).fillMaxHeight().background(Palette.BorderStrong))
                    Text(styled(b.spans, mono), style = body.copy(color = Palette.TextSecondary), modifier = Modifier.padding(start = 10.dp))
                }
                is Markdown.Block.Code -> CodeScroll(Palette.Surface) { scroll ->
                    Text(
                        b.text,
                        style = LocalOfficeType.current.monoBody.copy(fontSize = 12.5.sp, lineHeight = 18.sp),
                        softWrap = false,
                        modifier = scroll.background(Palette.Surface, RoundedCornerShape(4.dp)).padding(horizontal = 10.dp, vertical = 8.dp),
                    )
                }
                Markdown.Block.Rule -> Box(Modifier.fillMaxWidth().padding(vertical = 4.dp).height(1.dp).background(Palette.Border))
                is Markdown.Block.Table -> Table(b, body.copy(fontSize = 13.5.sp, lineHeight = 19.sp), mono)
            }
        }
    }
}

/** A visible cue only when the code really overflows, shared by messages and tool details. */
@Composable
internal fun CodeScroll(background: Color, content: @Composable (Modifier) -> Unit) {
    val scroll = rememberScrollState()
    Box(Modifier.fillMaxWidth().background(background, RoundedCornerShape(4.dp)).border(1.dp, Palette.Border, RoundedCornerShape(4.dp))) {
        content(Modifier.fillMaxWidth().horizontalScroll(scroll))
        OverflowCue(scroll, background)
    }
}

/**
 * While there is more to the right: a short fade at the edge and a small chevron in it, instead of
 * a caption under every box. Gone once scrolled to the end, and never there when nothing overflows.
 */
@Composable
private fun BoxScope.OverflowCue(scroll: ScrollState, background: Color) {
    val more by remember(scroll) { derivedStateOf { scroll.value < scroll.maxValue } }
    if (!more) return
    Box(
        Modifier.matchParentSize().drawBehind {
            val edge = 28.dp.toPx().coerceAtMost(size.width)
            drawRect(
                Brush.horizontalGradient(listOf(Color.Transparent, background), startX = size.width - edge, endX = size.width),
                topLeft = Offset(size.width - edge, 0f), size = Size(edge, size.height),
            )
        },
    )
    Icon(
        OfficeIcons.Chevron, "Scrolls sideways", tint = Palette.TextSecondary,
        modifier = Modifier.align(Alignment.TopEnd).padding(top = 9.dp, end = 3.dp).size(12.dp).tagged(Tags.Worker.THREAD_CODE_HINT),
    )
}

/** Above this a cell wraps, at its words, rather than making its column wider. */
private val CELL_MAX = 260.dp
private val CELL_MIN = 48.dp

/**
 * A Markdown table: every row lines its columns up with the others, each column as wide as its
 * widest cell up to [CELL_MAX], and the whole table scrolls sideways as one when it's wider than
 * the message, with the same edge cue as code.
 */
@Composable
private fun Table(t: Markdown.Block.Table, style: TextStyle, mono: FontFamily) {
    val scroll = rememberScrollState()
    val grid = remember(t) { Grid() }
    val head = style.copy(fontWeight = FontWeight.SemiBold)
    Box(Modifier.fillMaxWidth().tagged(Tags.Worker.THREAD_TABLE)) {
        Layout(
            content = {
                for (row in listOf(t.header) + t.rows) {
                    row.forEachIndexed { c, cell ->
                        Text(
                            styled(cell, mono),
                            style = if (row === t.header) head else style,
                            textAlign = when (t.align.getOrNull(c)) {
                                Markdown.Align.Center -> TextAlign.Center
                                Markdown.Align.Right -> TextAlign.End
                                else -> TextAlign.Start
                            },
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
                        )
                    }
                }
            },
            modifier = Modifier.horizontalScroll(scroll).drawBehind { grid.draw(this) },
        ) { measurables, _ ->
            val cols = t.align.size.coerceAtLeast(1)
            val rows = measurables.size / cols
            val cap = CELL_MAX.roundToPx()
            val floor = CELL_MIN.roundToPx()
            val widths = IntArray(cols) { c ->
                (0 until rows).maxOf { r -> measurables[r * cols + c].maxIntrinsicWidth(Constraints.Infinity) }.coerceIn(floor, cap)
            }
            val placeables = measurables.mapIndexed { i, m -> m.measure(Constraints(minWidth = widths[i % cols], maxWidth = widths[i % cols])) }
            val heights = IntArray(rows) { r -> (0 until cols).maxOf { c -> placeables[r * cols + c].height } }
            val width = widths.sum()
            val height = heights.sum()
            grid.columns = widths.runningFold(0) { a, w -> a + w }
            grid.rows = heights.toList().runningFold(0) { a, h -> a + h }
            grid.line = 1.dp.toPx()
            layout(width, height) {
                var y = 0
                for (r in 0 until rows) {
                    var x = 0
                    for (c in 0 until cols) {
                        placeables[r * cols + c].place(x, y)
                        x += widths[c]
                    }
                    y += heights[r]
                }
            }
        }
        OverflowCue(scroll, Palette.Bg)
    }
}

/** Where the last layout put a table's column and row edges, for its hairlines and header fill. */
private class Grid {
    // State, so a relayout that moves the edges without resizing the table still redraws them.
    var columns by mutableStateOf(emptyList<Int>())
    var rows by mutableStateOf(emptyList<Int>())
    var line = 1f

    fun draw(scope: DrawScope) = with(scope) {
        val cs = columns
        val rs = rows
        if (cs.size < 2 || rs.size < 2) return@with
        val w = cs.last().toFloat()
        val h = rs.last().toFloat()
        val half = line / 2
        drawRect(Palette.Surface, Offset.Zero, Size(w, rs[1].toFloat()))
        for (y in rs) {
            val at = y.toFloat().coerceIn(half, h - half)
            drawLine(Palette.Border, Offset(0f, at), Offset(w, at), line)
        }
        for (x in cs) {
            val at = x.toFloat().coerceIn(half, w - half)
            drawLine(Palette.Border, Offset(at, 0f), Offset(at, h), line)
        }
    }
}

private val linkStyles = TextLinkStyles(SpanStyle(color = Palette.Accent, textDecoration = TextDecoration.Underline))

private fun styled(spans: List<Markdown.Span>, mono: FontFamily): AnnotatedString = buildAnnotatedString {
    for (s in spans) {
        val style = SpanStyle(
            fontWeight = if (s.bold) FontWeight.SemiBold else null,
            fontStyle = if (s.italic) FontStyle.Italic else null,
            fontFamily = if (s.code) mono else null,
            fontSize = if (s.code) 0.9.em else TextUnit.Unspecified,
            background = if (s.code) Palette.SurfaceHigh else Color.Unspecified,
            textDecoration = if (s.strike) TextDecoration.LineThrough else null,
        )
        val link = s.link
        if (link != null) withLink(LinkAnnotation.Url(link, linkStyles)) { withStyle(style) { append(s.text) } }
        else withStyle(style) { append(s.text) }
    }
}
