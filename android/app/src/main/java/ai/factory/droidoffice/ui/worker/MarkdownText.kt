package ai.factory.droidoffice.ui.worker

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.BaselineShift
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import ai.factory.droidoffice.core.JsonWidget
import ai.factory.droidoffice.core.Markdown
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.TexMath
import ai.factory.droidoffice.core.WorkspacePaths
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.ThreadPalette
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val COPY_FEEDBACK_MS = 2_000L

/**
 * A message's Markdown, laid out with the office's type. Links open in the browser. [surface] is
 * what the message sits on, which a table's overflow fade blends into. With [onOpenPath], inline
 * code that names a workspace file (`src/a.ts:12`) is a link that opens it. With [rich] (an
 * assistant's reply, as the web Thread draws them), ```mermaid blocks are drawn as diagrams and
 * TeX math (`$…$`, `$$…$$`) is typeset.
 */
@Composable
internal fun MarkdownText(
    source: String,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
    surface: Color = ThreadPalette.Bg,
    breaks: Boolean = false,
    streaming: Boolean = false,
    onOpenPath: ((WorkspacePaths.Ref) -> Unit)? = null,
    rich: Boolean = false,
) {
    val paths = onOpenPath != null
    val blocks = remember(source, breaks, paths, rich) { Markdown.parse(source, breaks, paths, math = rich) }
    val open = rememberUpdatedState(onOpenPath)
    val opener: ((WorkspacePaths.Ref) -> Unit)? = if (paths) remember { { ref: WorkspacePaths.Ref -> open.value?.invoke(ref) } } else null
    val mono = LocalOfficeType.current.mono
    val shownBlocks = remember(streaming) { mutableIntStateOf(if (streaming) 0 else Int.MAX_VALUE) }
    val body = if (compact) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp, lineHeight = 22.sp, letterSpacing = (-0.02).em)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(if (compact) 3.dp else 8.dp)) {
        for ((index, b) in blocks.withIndex()) {
            EnteringBlock(streaming && index >= shownBlocks.intValue, onEntered = { shownBlocks.intValue = maxOf(shownBlocks.intValue, index + 1) }) {
                when (b) {
                    is Markdown.Block.Heading -> Text(
                        styled(b.spans, mono, opener),
                        style = body.copy(
                            fontSize = if (b.level <= 2) 16.sp else 15.sp,
                            lineHeight = 20.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = if (b.level == 6) ThreadPalette.Text.copy(alpha = 0.7f) else ThreadPalette.Text,
                        ),
                    )
                    is Markdown.Block.Paragraph -> Text(styled(b.spans, mono, opener), style = body)
                    is Markdown.Block.Item -> Row(Modifier.padding(start = (b.depth * 14).dp)) {
                        val marker = when (b.checked) {
                            true -> "☑"
                            false -> "☐"
                            null -> b.marker
                        }
                        Text(marker, style = body.copy(color = if (b.checked == true) ThreadPalette.Success else ThreadPalette.TextSecondary), modifier = Modifier.width(if (b.marker.length > 2) 30.dp else 20.dp))
                        Text(
                            styled(b.spans, mono, opener),
                            style = if (b.checked == true) body.copy(color = ThreadPalette.TextSecondary, textDecoration = TextDecoration.LineThrough) else body,
                        )
                    }
                    is Markdown.Block.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
                        Box(Modifier.width(4.dp).fillMaxHeight().background(ThreadPalette.BorderStrong))
                        Text(styled(b.spans, mono, opener), style = body.copy(color = ThreadPalette.TextSecondary), modifier = Modifier.padding(start = 16.dp))
                    }
                    is Markdown.Block.Alert -> AlertCard(b, body, mono, opener)
                    is Markdown.Block.Code -> if (rich && b.language.equals("mermaid", ignoreCase = true)) {
                        MermaidBlock(b, streaming, mono)
                    } else {
                        CodeBlockCard(b, mono)
                    }
                    is Markdown.Block.Widget -> WidgetBlock(b, streaming, mono)
                    is Markdown.Block.Math -> MathBlock(b, body)
                    is Markdown.Block.Image -> MarkdownImage(b.alt, b.src, body)
                    Markdown.Block.Rule -> Box(Modifier.fillMaxWidth().padding(vertical = 4.dp).height(1.dp).background(ThreadPalette.Border))
                    is Markdown.Block.Table -> Table(b, body.copy(fontSize = 12.sp, lineHeight = 20.7.sp), mono, surface, opener)
                }
            }
        }
    }
}

@Composable
private fun EnteringBlock(entering: Boolean, onEntered: () -> Unit, content: @Composable () -> Unit) {
    val alpha = remember { Animatable(if (entering) 0f else 1f) }
    val entered = rememberUpdatedState(onEntered)
    LaunchedEffect(entering) {
        if (entering) {
            alpha.animateTo(1f, animationSpec = tween(200, easing = CubicBezierEasing(0.23f, 1f, 0.32f, 1f)))
            entered.value()
        } else alpha.snapTo(1f)
    }
    Box(Modifier.graphicsLayer { this.alpha = alpha.value }) { content() }
}

@Composable
private fun CodeBlockCard(b: Markdown.Block.Code, mono: FontFamily) {
    val label = remember(b.language) { b.language?.trim()?.ifEmpty { null } ?: "code" }
    val lines = remember(b.text) { b.text.lines().size }
    var expanded by rememberSaveable { mutableStateOf(false) }
    val shape = RoundedCornerShape(4.dp)
    Column(Modifier.fillMaxWidth().panel(shape, ThreadPalette.Surface, ThreadPalette.BorderStrong)) {
        DisableSelection {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    label,
                    style = LocalOfficeType.current.monoBody.copy(fontSize = 12.sp, lineHeight = 20.7.sp, color = ThreadPalette.TextTertiary),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                CopyActionChip(
                    label = "Copy code",
                    textToCopy = b.text,
                    clipTitle = "Code",
                    tag = Tags.Worker.THREAD_CODE_COPY,
                    iconOnly = true,
                )
            }
        }
        if (lines > 10) {
            Box(
                Modifier.fillMaxWidth()
                    .heightIn(max = if (expanded) 500.dp else 180.dp)
                    .then(if (expanded) Modifier.verticalScroll(rememberScrollState()) else Modifier.clipToBounds()),
            ) {
                CodeBody(b.text, b.language, mono, wrap = true, background = ThreadPalette.Surface)
            }
            DisableSelection {
                Box(Modifier.fillMaxWidth().height(1.dp).background(ThreadPalette.BorderStrong))
                Text(
                    if (expanded) "Show less" else "Show more",
                    style = MaterialTheme.typography.bodySmall.copy(color = ThreadPalette.TextSecondary),
                    modifier = Modifier.fillMaxWidth()
                        .toggleable(expanded, role = Role.Switch, onValueChange = { expanded = it })
                        .padding(horizontal = 4.dp, vertical = 6.dp),
                    textAlign = TextAlign.Center,
                )
            }
        } else {
            CodeBody(b.text, b.language, mono, wrap = true, background = ThreadPalette.Surface)
        }
    }
}

/** A code block's highlighted text. Thread blocks wrap; tool details keep their sideways scroll. */
@Composable
internal fun CodeBody(text: String, language: String?, mono: FontFamily, wrap: Boolean = false, background: Color = ThreadPalette.Code) {
    val highlighted = remember(text, language) { highlightedCode(text, language) }
    val style = LocalOfficeType.current.monoBody.copy(fontSize = if (wrap) 12.sp else 12.5.sp, lineHeight = if (wrap) 20.7.sp else 18.sp)
    if (wrap) {
        Text(highlighted, style = style, softWrap = true, modifier = Modifier.fillMaxWidth().background(background).padding(8.dp))
    } else {
        CodeScroll(background, bordered = false) { scroll ->
            Text(
                highlighted,
                style = style,
                softWrap = false,
                modifier = scroll.background(background).padding(start = 10.dp, end = 10.dp, top = 4.dp, bottom = 10.dp),
            )
        }
    }
}

@Composable
private fun AlertCard(b: Markdown.Block.Alert, body: TextStyle, mono: FontFamily, opener: ((WorkspacePaths.Ref) -> Unit)?) {
    val (color, icon) = when (b.kind) {
        Markdown.AlertKind.Note -> ThreadPalette.TextSecondary to ToolIcons.Info
        Markdown.AlertKind.Tip -> ThreadPalette.TextSecondary to OfficeIcons.Sparkle
        Markdown.AlertKind.Important -> Color(0xFFFFA675) to OfficeIcons.Comment
        Markdown.AlertKind.Warning -> Color(0xFFF7A828) to ToolIcons.TriangleAlert
        Markdown.AlertKind.Caution -> Color(0xFFF0442E) to ToolIcons.CircleAlert
    }
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
        Box(Modifier.width(4.dp).fillMaxHeight().background(color))
        Column(Modifier.weight(1f).padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(icon, null, tint = color, modifier = Modifier.size(16.dp))
                Text(b.title ?: b.kind.label, style = body.copy(fontSize = 13.sp, fontWeight = FontWeight.Medium, color = color))
            }
            for (paragraph in b.paragraphs) Text(styled(paragraph, mono, opener), style = body)
        }
    }
}

@Composable
internal fun CopyActionChip(
    label: String,
    textToCopy: String,
    clipTitle: String,
    tag: String,
    modifier: Modifier = Modifier,
    iconOnly: Boolean = false,
) {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var copyGen by remember { mutableIntStateOf(0) }
    val copied = copyGen > 0
    val shape = RoundedCornerShape(3.dp)
    Row(
        modifier
            .clip(shape)
            .clickable(role = Role.Button, onClickLabel = label) {
                val next = copyGen + 1
                copyGen = next
                scope.launch {
                    runCatching { clipboard.setClipEntry(workerTextClip(clipTitle, textToCopy)) }
                    delay(COPY_FEEDBACK_MS)
                    if (copyGen == next) copyGen = 0
                }
            }
            .tagged(tag)
            .heightIn(min = 28.dp)
            .padding(horizontal = 7.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        val description = when {
            !iconOnly -> null
            !copied -> label
            label == "Copy code" -> "Code copied"
            else -> "Copied"
        }
        val tint = when {
            copied -> ThreadPalette.Success
            iconOnly -> ThreadPalette.TextSecondary.copy(alpha = 0.5f)
            else -> ThreadPalette.TextSecondary
        }
        Icon(
            if (copied) OfficeIcons.Check else OfficeIcons.Copy,
            contentDescription = description,
            tint = tint,
            modifier = Modifier.size(12.dp),
        )
        if (!iconOnly) {
            Text(
                if (copied) "COPIED" else label.uppercase(),
                style = LocalOfficeType.current.eyebrow.copy(color = if (copied) ThreadPalette.Success else ThreadPalette.TextSecondary),
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun WidgetBlock(w: Markdown.Block.Widget, streaming: Boolean, mono: FontFamily) {
    if (!w.complete) {
        WidgetLoadingCard()
        return
    }
    val root = remember(w.rawJson) { JsonWidget.parse(w.rawJson) }
    if (root == null) {
        if (streaming) WidgetLoadingCard()
        return
    }
    Column(
        Modifier.fillMaxWidth()
            .panel(RoundedCornerShape(4.dp), ThreadPalette.Surface, ThreadPalette.Border)
            .tagged(Tags.Worker.THREAD_WIDGET)
            .padding(10.dp),
    ) {
        RenderWidgetNode(root, mono)
    }
}

@Composable
private fun WidgetLoadingCard() {
    DisableSelection {
        Row(
            Modifier.fillMaxWidth()
                .panel(RoundedCornerShape(4.dp), ThreadPalette.Surface, ThreadPalette.Border)
                .tagged(Tags.Worker.THREAD_WIDGET)
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Spinner(Modifier.size(12.dp), ThreadPalette.TextSecondary)
            Text("Rendering widget…", style = MaterialTheme.typography.bodySmall.copy(color = ThreadPalette.TextSecondary))
        }
    }
}

@Composable
private fun RenderWidgetNode(node: JsonWidget.Node, mono: FontFamily) {
    when (node) {
        is JsonWidget.Node.Box -> {
            val ordered = when (node.direction) {
                JsonWidget.Direction.RowReverse, JsonWidget.Direction.ColumnReverse -> node.children.asReversed()
                else -> node.children
            }
            val gap = (node.gapDp ?: 6).dp
            val pad = (node.paddingDp ?: 0).dp
            val borderMod = when (node.border) {
                JsonWidget.BorderKind.None -> Modifier
                JsonWidget.BorderKind.Solid -> Modifier.border(1.dp, ThreadPalette.BorderStrong, RoundedCornerShape(4.dp))
                JsonWidget.BorderKind.Dashed, JsonWidget.BorderKind.Dotted -> {
                    val dash = if (node.border == JsonWidget.BorderKind.Dotted) floatArrayOf(4f, 4f) else floatArrayOf(10f, 6f)
                    Modifier.drawBehind {
                        drawRoundRect(
                            color = ThreadPalette.BorderStrong,
                            cornerRadius = CornerRadius(4.dp.toPx()),
                            style = Stroke(width = 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(dash)),
                        )
                    }
                }
            }
            val mod = Modifier.then(borderMod).then(if (pad > 0.dp) Modifier.padding(pad) else Modifier)
            if (node.direction == JsonWidget.Direction.Row || node.direction == JsonWidget.Direction.RowReverse) {
                FlowRow(mod.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap), verticalArrangement = Arrangement.spacedBy(gap)) {
                    for (child in ordered) RenderWidgetNode(child, mono)
                }
            } else {
                Column(mod.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(gap)) {
                    for (child in ordered) RenderWidgetNode(child, mono)
                }
            }
        }
        is JsonWidget.Node.Card -> {
            val pad = (node.paddingDp ?: 10).dp
            Column(Modifier.fillMaxWidth().panel(RoundedCornerShape(4.dp), ThreadPalette.SurfaceRaised, ThreadPalette.Border)) {
                node.title?.let { title ->
                    Text(
                        title.uppercase(),
                        style = LocalOfficeType.current.eyebrow.copy(color = ThreadPalette.TextSecondary),
                        modifier = Modifier.fillMaxWidth().background(ThreadPalette.SurfaceHigh).padding(horizontal = 10.dp, vertical = 6.dp),
                    )
                    if (node.children.isNotEmpty()) Box(Modifier.fillMaxWidth().height(1.dp).background(ThreadPalette.Border))
                }
                if (node.children.isNotEmpty()) {
                    Column(Modifier.fillMaxWidth().padding(pad), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (child in node.children) RenderWidgetNode(child, mono)
                    }
                }
            }
        }
        is JsonWidget.Node.Text -> {
            val color = node.color?.let(::resolveToneColor) ?: ThreadPalette.Text
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (node.text.isNotEmpty()) {
                    Text(
                        node.text,
                        style = MaterialTheme.typography.bodyMedium.copy(
                            fontSize = 13.5.sp,
                            lineHeight = 19.sp,
                            fontWeight = if (node.bold) FontWeight.SemiBold else FontWeight.Normal,
                            color = color,
                        ),
                    )
                }
                for (child in node.children) RenderWidgetNode(child, mono)
            }
        }
        is JsonWidget.Node.Heading -> {
            val style = when (node.level) {
                1 -> MaterialTheme.typography.titleLarge
                2 -> MaterialTheme.typography.titleMedium
                3, 4 -> MaterialTheme.typography.titleSmall
                else -> MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold)
            }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (node.text.isNotEmpty()) Text(node.text, style = style)
                for (child in node.children) RenderWidgetNode(child, mono)
            }
        }
        is JsonWidget.Node.Divider -> {
            val title = node.title
            if (title != null) {
                Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f).height(1.dp).background(ThreadPalette.Border))
                    Text(title.uppercase(), style = LocalOfficeType.current.eyebrow.copy(color = ThreadPalette.TextSecondary), modifier = Modifier.padding(horizontal = 8.dp))
                    Box(Modifier.weight(1f).height(1.dp).background(ThreadPalette.Border))
                }
            } else {
                Box(Modifier.fillMaxWidth().padding(vertical = 2.dp).height(1.dp).background(ThreadPalette.Border))
            }
        }
        JsonWidget.Node.Newline -> Spacer(Modifier.height(6.dp))
        JsonWidget.Node.Spacer -> Spacer(Modifier.size(8.dp))
        is JsonWidget.Node.KeyValue -> {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
                Text(node.label, style = MaterialTheme.typography.bodySmall.copy(color = ThreadPalette.TextSecondary), modifier = Modifier.weight(1f).padding(end = 10.dp))
                Text(node.value, style = LocalOfficeType.current.monoBody.copy(fontSize = 12.5.sp, lineHeight = 18.sp, color = ThreadPalette.Text))
            }
        }
        is JsonWidget.Node.StatusLine -> {
            val dotColor = when (node.status) {
                JsonWidget.StatusKind.Success -> ThreadPalette.Success
                JsonWidget.StatusKind.Error -> ThreadPalette.Danger
                JsonWidget.StatusKind.Warning -> ThreadPalette.Warning
                JsonWidget.StatusKind.Info -> ThreadPalette.Info
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                Box(Modifier.size(6.dp).clip(CircleShape).background(dotColor))
                Text(node.text, style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.5.sp, lineHeight = 19.sp))
            }
        }
        is JsonWidget.Node.Badge -> {
            val fg = when (node.variant) {
                JsonWidget.BadgeVariant.Muted -> ThreadPalette.TextSecondary
                JsonWidget.BadgeVariant.Success -> ThreadPalette.Success
                JsonWidget.BadgeVariant.Warning -> ThreadPalette.Warning
                JsonWidget.BadgeVariant.Danger -> ThreadPalette.Danger
                JsonWidget.BadgeVariant.Info -> ThreadPalette.Info
                JsonWidget.BadgeVariant.Accent -> ThreadPalette.Accent
                JsonWidget.BadgeVariant.Default -> ThreadPalette.Text
            }
            val shape = RoundedCornerShape(3.dp)
            Box(
                Modifier.clip(shape)
                    .background(fg.copy(alpha = 0.12f))
                    .border(1.dp, fg.copy(alpha = 0.35f), shape)
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            ) {
                Text(node.label.uppercase(), style = LocalOfficeType.current.eyebrow.copy(color = fg, fontSize = 10.sp))
            }
        }
        is JsonWidget.Node.Metric -> {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                node.label?.let { Text(it.uppercase(), style = LocalOfficeType.current.eyebrow.copy(color = ThreadPalette.TextSecondary)) }
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    node.value?.let {
                        Text(it, style = LocalOfficeType.current.monoBody.copy(fontSize = 20.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold, color = ThreadPalette.Text))
                    }
                    node.trend?.let { t ->
                        val (arrow, c) = when (t) {
                            JsonWidget.Trend.Up -> "↑" to ThreadPalette.Success
                            JsonWidget.Trend.Down -> "↓" to ThreadPalette.Danger
                            JsonWidget.Trend.Flat -> "→" to ThreadPalette.TextSecondary
                        }
                        Text(arrow, style = LocalOfficeType.current.monoBody.copy(fontSize = 13.sp, color = c), modifier = Modifier.padding(bottom = 2.dp))
                    }
                }
            }
        }
        is JsonWidget.Node.ProgressBar -> {
            val widthDp = node.widthDp
            val mod = if (widthDp != null) Modifier.widthIn(max = widthDp.dp).fillMaxWidth() else Modifier.fillMaxWidth()
            Column(mod, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    val label = node.label
                    if (label != null) {
                        Text(label, style = MaterialTheme.typography.bodySmall.copy(color = ThreadPalette.TextSecondary), modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    } else {
                        Spacer(Modifier.weight(1f))
                    }
                    Text("${node.percent}%", style = LocalOfficeType.current.eyebrow.copy(color = ThreadPalette.Text))
                }
                Box(Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(2.dp)).background(ThreadPalette.SurfaceHigh)) {
                    Box(Modifier.fillMaxWidth(node.progress).fillMaxHeight().background(ThreadPalette.Accent))
                }
            }
        }
        is JsonWidget.Node.BarChart -> {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (bar in node.bars) {
                    val c = bar.color?.let(::resolveToneColor) ?: ThreadPalette.Accent
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(bar.label, style = MaterialTheme.typography.bodySmall.copy(color = ThreadPalette.TextSecondary), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(min = 60.dp, max = 120.dp))
                        Box(Modifier.weight(1f).height(8.dp).clip(RoundedCornerShape(2.dp)).background(ThreadPalette.SurfaceHigh)) {
                            Box(Modifier.fillMaxWidth(bar.fraction).fillMaxHeight().background(c))
                        }
                        Text(bar.valueLabel, style = LocalOfficeType.current.monoBody.copy(fontSize = 11.5.sp, color = ThreadPalette.Text))
                    }
                }
            }
        }
        is JsonWidget.Node.Sparkline -> {
            val lineColor = node.color?.let(::resolveToneColor) ?: ThreadPalette.Accent
            Canvas(
                Modifier.width(136.dp).height(32.dp).semantics { contentDescription = node.summary },
            ) {
                val pad = 3.dp.toPx()
                val w = size.width
                val h = size.height
                val span = node.max - node.min
                val pts = node.points.mapIndexed { idx, v ->
                    val x = if (node.points.size == 1) w / 2f else pad + (idx.toFloat() / (node.points.size - 1)) * (w - pad * 2f)
                    val y = if (span == 0.0) h / 2f else (h - pad - ((v - node.min) / span).toFloat() * (h - pad * 2f))
                    Offset(x, y)
                }
                if (pts.size >= 2) {
                    val area = Path().apply {
                        moveTo(pts.first().x, h - pad)
                        pts.forEach { lineTo(it.x, it.y) }
                        lineTo(pts.last().x, h - pad)
                        close()
                    }
                    drawPath(area, lineColor.copy(alpha = 0.16f))
                    val stroke = Path().apply {
                        moveTo(pts.first().x, pts.first().y)
                        pts.drop(1).forEach { lineTo(it.x, it.y) }
                    }
                    drawPath(stroke, lineColor, style = Stroke(width = 1.75.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
                } else {
                    drawLine(lineColor, Offset(pad, h / 2f), Offset(w - pad, h / 2f), strokeWidth = 1.75.dp.toPx())
                }
                pts.lastOrNull()?.let { last -> drawCircle(lineColor, radius = 2.5.dp.toPx(), center = last) }
            }
        }
        is JsonWidget.Node.Table -> {
            val headColor = node.headerColor?.let(::resolveToneColor) ?: ThreadPalette.TextSecondary
            CodeScroll(ThreadPalette.SurfaceRaised) { scroll ->
                Column(scroll) {
                    Row(Modifier.background(ThreadPalette.SurfaceHigh)) {
                        node.columns.forEach { col ->
                            val wMod = Modifier.width((col.widthDp ?: 116).coerceIn(56, 260).dp).padding(horizontal = 8.dp, vertical = 6.dp)
                            Text(col.header.uppercase(), style = LocalOfficeType.current.eyebrow.copy(color = headColor), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = wMod)
                        }
                    }
                    node.rows.forEach { row ->
                        Box(Modifier.fillMaxWidth().height(1.dp).background(ThreadPalette.Border))
                        Row {
                            node.columns.forEachIndexed { idx, col ->
                                val wMod = Modifier.width((col.widthDp ?: 116).coerceIn(56, 260).dp).padding(horizontal = 8.dp, vertical = 6.dp)
                                Text(row.getOrElse(idx) { "" }, style = MaterialTheme.typography.bodySmall.copy(color = ThreadPalette.Text), maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = wMod)
                            }
                        }
                    }
                }
            }
        }
        is JsonWidget.Node.ListBlock -> {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                node.items.forEachIndexed { idx, item ->
                    Row {
                        val marker = if (node.ordered) "${idx + 1}." else "•"
                        Text(marker, style = MaterialTheme.typography.bodySmall.copy(color = ThreadPalette.TextSecondary), modifier = Modifier.width(if (node.ordered) 24.dp else 16.dp))
                        Text(item, style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.5.sp, lineHeight = 19.sp))
                    }
                }
            }
        }
        is JsonWidget.Node.Callout -> {
            val accent = when (node.tone) {
                JsonWidget.CalloutTone.Info -> ThreadPalette.Info
                JsonWidget.CalloutTone.Success -> ThreadPalette.Success
                JsonWidget.CalloutTone.Warning -> ThreadPalette.Warning
                JsonWidget.CalloutTone.Danger -> ThreadPalette.Danger
            }
            Column(
                Modifier.fillMaxWidth()
                    .panel(RoundedCornerShape(4.dp), accent.copy(alpha = 0.08f), accent.copy(alpha = 0.35f))
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                node.title?.let { Text(it, style = MaterialTheme.typography.titleSmall.copy(color = accent)) }
                node.content?.let { Text(it, style = MaterialTheme.typography.bodySmall.copy(color = ThreadPalette.Text, lineHeight = 18.sp)) }
                for (child in node.children) RenderWidgetNode(child, mono)
            }
        }
        is JsonWidget.Node.Timeline -> {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                node.items.forEach { item ->
                    val dot = when (item.status) {
                        JsonWidget.TimelineStatus.Done -> ThreadPalette.Success
                        JsonWidget.TimelineStatus.Active -> ThreadPalette.Accent
                        JsonWidget.TimelineStatus.Error -> ThreadPalette.Danger
                        JsonWidget.TimelineStatus.Pending -> ThreadPalette.TextTertiary
                    }
                    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Box(Modifier.padding(top = 6.dp).size(7.dp).clip(CircleShape).background(dot))
                        Column(Modifier.weight(1f)) {
                            Text(item.title, style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.5.sp, fontWeight = FontWeight.Medium, color = ThreadPalette.Text))
                            item.description?.let { Text(it, style = MaterialTheme.typography.bodySmall.copy(color = ThreadPalette.TextSecondary)) }
                        }
                    }
                }
            }
        }
    }
}

private fun resolveToneColor(tone: JsonWidget.ToneColor): Color = when (tone) {
    JsonWidget.ToneColor.Accent -> ThreadPalette.Accent
    JsonWidget.ToneColor.Success -> ThreadPalette.Success
    JsonWidget.ToneColor.Warning -> ThreadPalette.Warning
    JsonWidget.ToneColor.Danger -> ThreadPalette.Danger
    JsonWidget.ToneColor.Info -> ThreadPalette.Info
    JsonWidget.ToneColor.Muted -> ThreadPalette.TextSecondary
    JsonWidget.ToneColor.Purple -> Color(0xFFC084FC)
    is JsonWidget.ToneColor.Hex -> Color(tone.argb)
}

internal fun highlightedCode(text: String, language: String?): AnnotatedString {
    val tokens = Markdown.tokenizeCode(text, language)
    if (tokens.size <= 1 && tokens.firstOrNull()?.kind == Markdown.TokenKind.Plain) return AnnotatedString(text)
    return buildAnnotatedString {
        for (tok in tokens) {
            val c = when (tok.kind) {
                Markdown.TokenKind.Plain -> ThreadPalette.Text
                Markdown.TokenKind.Keyword -> ThreadPalette.AccentHover
                Markdown.TokenKind.Type -> ThreadPalette.Info
                Markdown.TokenKind.String -> ThreadPalette.Success
                Markdown.TokenKind.Number -> ThreadPalette.Warning
                Markdown.TokenKind.Comment -> ThreadPalette.TextSecondary
            }
            if (tok.kind == Markdown.TokenKind.Plain) append(tok.text)
            else withStyle(SpanStyle(color = c)) { append(tok.text) }
        }
    }
}

/** A visible cue only when the code really overflows, shared by messages and tool details. */
@Composable
internal fun CodeScroll(background: Color, modifier: Modifier = Modifier, bordered: Boolean = true, content: @Composable (Modifier) -> Unit) {
    val scroll = rememberScrollState()
    val frame = if (bordered) {
        modifier.fillMaxWidth().background(background, RoundedCornerShape(4.dp)).border(1.dp, ThreadPalette.Border, RoundedCornerShape(4.dp))
    } else {
        modifier.fillMaxWidth().background(background)
    }
    Box(frame) {
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
        OfficeIcons.Chevron, "Scrolls sideways", tint = ThreadPalette.TextSecondary,
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
private fun Table(t: Markdown.Block.Table, style: TextStyle, mono: FontFamily, surface: Color, opener: ((WorkspacePaths.Ref) -> Unit)?, actions: Boolean = true) {
    val scroll = rememberScrollState()
    val grid = remember(t) { Grid() }
    val head = style.copy(fontWeight = FontWeight.SemiBold)
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var showActions by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    var expanded by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(4.dp)
    Box(Modifier.fillMaxWidth().tagged(Tags.Worker.THREAD_TABLE)) {
        Box(
            Modifier.fillMaxWidth()
                .then(if (actions) Modifier.combinedClickable(onClick = {}, onLongClick = { showActions = true }) else Modifier)
                .clip(shape)
                .border(1.dp, ThreadPalette.BorderStrong, shape),
        ) {
            Layout(
                content = {
                    for (row in listOf(t.header) + t.rows) {
                        row.forEachIndexed { c, cell -> Cell(cell, if (row === t.header) head else style, t.align.getOrNull(c), mono, opener) }
                    }
                },
                modifier = Modifier.horizontalScroll(scroll).drawBehind { grid.draw(this) },
            ) { measurables, _ ->
                val cols = t.align.size.coerceAtLeast(1)
                val rows = measurables.size / cols
                val cap = CELL_MAX.roundToPx()
                val floor = CELL_MIN.roundToPx()
                // Never narrower than a cell's widest unbreakable piece (a long word, a command in code):
                // the table scrolls sideways instead of breaking it.
                val widths = IntArray(cols) { c ->
                    val natural = (0 until rows).maxOf { r -> measurables[r * cols + c].maxIntrinsicWidth(Constraints.Infinity) }.coerceIn(floor, cap)
                    maxOf(natural, (0 until rows).maxOf { r -> measurables[r * cols + c].minIntrinsicWidth(Constraints.Infinity) })
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
            OverflowCue(scroll, surface)
        }
        if (actions) {
            DropdownMenu(expanded = showActions, onDismissRequest = { showActions = false }) {
                DropdownMenuItem(
                    text = { Text(if (copied) "Markdown table copied" else "Copy Markdown table") },
                    onClick = {
                        showActions = false
                        scope.launch {
                            try {
                                if (runCatching { clipboard.setClipEntry(workerTextClip("Markdown table", t.raw)) }.isSuccess) {
                                    copied = true
                                    delay(COPY_FEEDBACK_MS)
                                }
                            } finally {
                                copied = false
                            }
                        }
                    },
                )
                DropdownMenuItem(text = { Text("Expand Markdown table") }, onClick = {
                    showActions = false
                    expanded = true
                })
            }
        }
    }
    if (expanded) {
        Dialog(onDismissRequest = { expanded = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
            Column(Modifier.fillMaxSize().background(ThreadPalette.Bg).padding(24.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("Table", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                    IconButton(onClick = { expanded = false }) { Icon(Icons.Filled.Close, "Close table", tint = ThreadPalette.Text) }
                }
                Box(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), contentAlignment = Alignment.Center) {
                    Table(t, style, mono, surface, opener, actions = false)
                }
            }
        }
    }
}

/**
 * One cell. With inline code in it, the cell flows its pieces itself, breaking only between them
 * ([Markdown.unbroken]): Android's line breaker would otherwise split a path at its slashes.
 */
@Composable
private fun Cell(spans: List<Markdown.Span>, style: TextStyle, align: Markdown.Align?, mono: FontFamily, opener: ((WorkspacePaths.Ref) -> Unit)?) {
    val pad = Modifier.padding(horizontal = 13.dp, vertical = 8.dp)
    if (spans.none { it.code }) {
        Text(
            styled(spans, mono, opener), style = style, modifier = pad,
            textAlign = when (align) {
                Markdown.Align.Center -> TextAlign.Center
                Markdown.Align.Right -> TextAlign.End
                else -> TextAlign.Start
            },
        )
        return
    }
    val pieces = remember(spans) { Markdown.unbroken(spans) }
    FlowRow(
        pad,
        horizontalArrangement = when (align) {
            Markdown.Align.Center -> Arrangement.Center
            Markdown.Align.Right -> Arrangement.End
            else -> Arrangement.Start
        },
    ) {
        for (p in pieces) Text(styled(p, mono, opener), style = style, softWrap = false, maxLines = 1)
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
        for (y in rs.drop(1).dropLast(1)) {
            val at = y.toFloat().coerceIn(half, h - half)
            drawLine(ThreadPalette.BorderStrong, Offset(0f, at), Offset(w, at), line)
        }
        for (x in cs.drop(1).dropLast(1)) {
            val at = x.toFloat().coerceIn(half, w - half)
            drawLine(ThreadPalette.BorderStrong, Offset(at, 0f), Offset(at, h), line)
        }
    }
}

// Blue, without an underline, as the Factory app sets links; the colour alone marks them.
private val linkStyles = TextLinkStyles(SpanStyle(color = ThreadPalette.Link))
private val fileLinkStyles = TextLinkStyles(SpanStyle())

private fun styled(spans: List<Markdown.Span>, mono: FontFamily, opener: ((WorkspacePaths.Ref) -> Unit)? = null): AnnotatedString = buildAnnotatedString {
    for (s in spans) {
        val style = SpanStyle(
            fontWeight = if (s.bold) FontWeight.ExtraBold else null,
            fontStyle = if (s.italic) FontStyle.Italic else null,
            fontFamily = if (s.code) mono else null,
            fontSize = if (s.code) 0.923.em else TextUnit.Unspecified,
            background = if (s.code) ThreadPalette.Code else Color.Unspecified,
            textDecoration = if (s.strike) TextDecoration.LineThrough else null,
        )
        val link = s.link
        val file = s.file
        val math = s.math?.let(TexMath::inline)
        val body: AnnotatedString.Builder.() -> Unit = { withStyle(style) { if (math != null) appendMath(math) else append(s.text) } }
        when {
            link != null -> withLink(LinkAnnotation.Url(link, linkStyles), body)
            file != null && opener != null -> withLink(LinkAnnotation.Clickable("file:${file.label}", fileLinkStyles) { opener(file) }, body)
            else -> body()
        }
    }
}

/** [tex] laid out as text ([TexMath.inline]), or null when it is more than simple TeX. */
internal fun mathText(tex: String): AnnotatedString? = TexMath.inline(tex)?.let { runs -> buildAnnotatedString { appendMath(runs) } }

private fun AnnotatedString.Builder.appendMath(runs: List<TexMath.Run>) {
    for (r in runs) {
        val style = SpanStyle(
            fontFamily = FontFamily.Serif,
            fontStyle = if (r.italic) FontStyle.Italic else FontStyle.Normal,
            fontWeight = if (r.bold) FontWeight.Bold else null,
            baselineShift = when (r.shift) {
                TexMath.Shift.Super -> BaselineShift.Superscript
                TexMath.Shift.Sub -> BaselineShift.Subscript
                TexMath.Shift.None -> null
            },
            fontSize = if (r.shift == TexMath.Shift.None) TextUnit.Unspecified else 0.72.em,
        )
        withStyle(style) { append(r.text) }
    }
}
