package ai.factory.droidoffice.ui.worker

import android.content.ClipData
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalUriHandler
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
import ai.factory.droidoffice.core.JsonWidget
import ai.factory.droidoffice.core.Markdown
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.WorkspacePaths
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val COPY_FEEDBACK_MS = 1_500L

/**
 * A message's Markdown, laid out with the office's type. Links open in the browser. [surface] is
 * what the message sits on, which a table's overflow fade blends into. With [onOpenPath], the
 * workspace files the text names (`src/a.ts:12`) are links that open them.
 */
@Composable
internal fun MarkdownText(
    source: String,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
    surface: Color = Palette.Bg,
    breaks: Boolean = false,
    streaming: Boolean = false,
    onOpenPath: ((WorkspacePaths.Ref) -> Unit)? = null,
) {
    val paths = onOpenPath != null
    val blocks = remember(source, breaks, paths) { Markdown.parse(source, breaks, paths) }
    val open = rememberUpdatedState(onOpenPath)
    val opener: ((WorkspacePaths.Ref) -> Unit)? = if (paths) remember { { ref: WorkspacePaths.Ref -> open.value?.invoke(ref) } } else null
    val mono = LocalOfficeType.current.mono
    val body = if (compact) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp, lineHeight = 22.sp)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(if (compact) 3.dp else 8.dp)) {
        for (b in blocks) {
            when (b) {
                is Markdown.Block.Heading -> Text(
                    styled(b.spans, mono, opener),
                    style = when (b.level) {
                        1 -> MaterialTheme.typography.titleLarge
                        2 -> MaterialTheme.typography.titleMedium
                        else -> MaterialTheme.typography.titleSmall
                    },
                )
                is Markdown.Block.Paragraph -> Text(styled(b.spans, mono, opener), style = body)
                is Markdown.Block.Item -> Row(Modifier.padding(start = (b.depth * 14).dp)) {
                    val marker = when (b.checked) {
                        true -> "☑"
                        false -> "☐"
                        null -> b.marker
                    }
                    Text(marker, style = body.copy(color = if (b.checked == true) Palette.Success else Palette.TextSecondary), modifier = Modifier.width(if (b.marker.length > 2) 30.dp else 20.dp))
                    Text(
                        styled(b.spans, mono, opener),
                        style = if (b.checked == true) body.copy(color = Palette.TextSecondary, textDecoration = TextDecoration.LineThrough) else body,
                    )
                }
                is Markdown.Block.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
                    Box(Modifier.width(2.dp).fillMaxHeight().background(Palette.BorderStrong))
                    Text(styled(b.spans, mono, opener), style = body.copy(color = Palette.TextSecondary), modifier = Modifier.padding(start = 10.dp))
                }
                is Markdown.Block.Code -> CodeBlockCard(b, mono)
                is Markdown.Block.Email -> EmailDraftCard(b, body)
                is Markdown.Block.Widget -> WidgetBlock(b, streaming, mono)
                Markdown.Block.Rule -> Box(Modifier.fillMaxWidth().padding(vertical = 4.dp).height(1.dp).background(Palette.Border))
                is Markdown.Block.Table -> Table(b, body.copy(fontSize = 13.5.sp, lineHeight = 19.sp), mono, surface, opener)
            }
        }
    }
}

@Composable
private fun CodeBlockCard(b: Markdown.Block.Code, mono: FontFamily) {
    val label = remember(b.language) { (b.language?.trim()?.ifEmpty { null } ?: "code").uppercase() }
    val highlighted = remember(b.text, b.language, mono) { highlightedCode(b.text, b.language) }
    val shape = RoundedCornerShape(4.dp)
    Column(Modifier.fillMaxWidth().panel(shape, Palette.Surface, Palette.Border)) {
        DisableSelection {
            Row(
                Modifier.fillMaxWidth().background(Palette.SurfaceRaised).padding(start = 10.dp, end = 6.dp, top = 3.dp, bottom = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    label,
                    style = LocalOfficeType.current.eyebrow.copy(color = Palette.TextSecondary),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                CopyActionChip(
                    label = "COPY",
                    textToCopy = b.text,
                    clipTitle = "Code",
                    tag = Tags.Worker.THREAD_CODE_COPY,
                )
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Border))
        CodeScroll(Palette.Surface, bordered = false) { scroll ->
            Text(
                highlighted,
                style = LocalOfficeType.current.monoBody.copy(fontSize = 12.5.sp, lineHeight = 18.sp),
                softWrap = false,
                modifier = scroll.background(Palette.Surface).padding(horizontal = 10.dp, vertical = 8.dp),
            )
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
                    runCatching { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(clipTitle, textToCopy))) }
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
        Icon(
            if (copied) OfficeIcons.Check else OfficeIcons.Copy,
            contentDescription = if (iconOnly) (if (copied) "Copied" else label) else null,
            tint = if (copied) Palette.Success else Palette.TextSecondary,
            modifier = Modifier.size(12.dp),
        )
        if (!iconOnly || copied) {
            Text(
                if (copied) "COPIED" else label.uppercase(),
                style = LocalOfficeType.current.eyebrow.copy(color = if (copied) Palette.Success else Palette.TextSecondary),
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun EmailDraftCard(email: Markdown.Block.Email, bodyStyle: TextStyle) {
    val uriHandler = LocalUriHandler.current
    val shape = RoundedCornerShape(4.dp)
    Column(Modifier.fillMaxWidth().panel(shape, Palette.Surface, Palette.Border).tagged(Tags.Worker.THREAD_EMAIL)) {
        DisableSelection {
            Column(Modifier.fillMaxWidth().background(Palette.SurfaceRaised).padding(horizontal = 10.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Icon(OfficeIcons.Mail, null, tint = Palette.TextSecondary, modifier = Modifier.size(13.dp))
                    Text("EMAIL DRAFT", style = LocalOfficeType.current.eyebrow.copy(color = Palette.TextSecondary), modifier = Modifier.weight(1f))
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    CopyActionChip("COPY BODY", email.body, "Email body", Tags.Worker.THREAD_EMAIL_COPY_BODY)
                    CopyActionChip("COPY ALL", email.raw, "Email draft", Tags.Worker.THREAD_EMAIL_COPY_ALL)
                    EmailActionButton("OPEN IN MAIL", OfficeIcons.External, Tags.Worker.THREAD_EMAIL_OPEN) {
                        runCatching { uriHandler.openUri(email.mailtoUri()) }
                    }
                }
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Border))
        Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (email.to.isNotEmpty()) EmailFieldRow("To", email.to, bold = false)
            email.cc?.let { EmailFieldRow("Cc", it, bold = false) }
            email.bcc?.let { EmailFieldRow("Bcc", it, bold = false) }
            if (email.subject.isNotEmpty()) EmailFieldRow("Subject", email.subject, bold = true)
        }
        if (email.body.isNotEmpty()) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Border))
            Text(
                email.body,
                style = bodyStyle.copy(fontSize = 14.sp, lineHeight = 20.sp),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 9.dp),
            )
        }
    }
}

@Composable
private fun EmailActionButton(label: String, icon: ImageVector, tag: String, onClick: () -> Unit) {
    val shape = RoundedCornerShape(3.dp)
    Row(
        Modifier.clip(shape)
            .border(1.dp, Palette.BorderStrong, shape)
            .clickable(role = Role.Button, onClick = onClick)
            .tagged(tag)
            .heightIn(min = 28.dp)
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Icon(icon, null, tint = Palette.Accent, modifier = Modifier.size(12.dp))
        Text(label, style = LocalOfficeType.current.eyebrow.copy(color = Palette.Text), maxLines = 1)
    }
}

@Composable
private fun EmailFieldRow(label: String, value: String, bold: Boolean) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Text(
            label.uppercase(),
            style = LocalOfficeType.current.eyebrow.copy(color = Palette.TextSecondary),
            modifier = Modifier.width(64.dp).padding(top = 2.dp),
        )
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium.copy(
                fontSize = 13.5.sp,
                lineHeight = 19.sp,
                fontWeight = if (bold) FontWeight.SemiBold else FontWeight.Normal,
                color = Palette.Text,
            ),
            modifier = Modifier.weight(1f),
        )
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
            .panel(RoundedCornerShape(4.dp), Palette.Surface, Palette.Border)
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
                .panel(RoundedCornerShape(4.dp), Palette.Surface, Palette.Border)
                .tagged(Tags.Worker.THREAD_WIDGET)
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Spinner(Modifier.size(12.dp), Palette.TextSecondary)
            Text("Rendering widget…", style = MaterialTheme.typography.bodySmall.copy(color = Palette.TextSecondary))
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
                JsonWidget.BorderKind.Solid -> Modifier.border(1.dp, Palette.BorderStrong, RoundedCornerShape(4.dp))
                JsonWidget.BorderKind.Dashed, JsonWidget.BorderKind.Dotted -> {
                    val dash = if (node.border == JsonWidget.BorderKind.Dotted) floatArrayOf(4f, 4f) else floatArrayOf(10f, 6f)
                    Modifier.drawBehind {
                        drawRoundRect(
                            color = Palette.BorderStrong,
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
            Column(Modifier.fillMaxWidth().panel(RoundedCornerShape(4.dp), Palette.SurfaceRaised, Palette.Border)) {
                node.title?.let { title ->
                    Text(
                        title.uppercase(),
                        style = LocalOfficeType.current.eyebrow.copy(color = Palette.TextSecondary),
                        modifier = Modifier.fillMaxWidth().background(Palette.SurfaceHigh).padding(horizontal = 10.dp, vertical = 6.dp),
                    )
                    if (node.children.isNotEmpty()) Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Border))
                }
                if (node.children.isNotEmpty()) {
                    Column(Modifier.fillMaxWidth().padding(pad), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (child in node.children) RenderWidgetNode(child, mono)
                    }
                }
            }
        }
        is JsonWidget.Node.Text -> {
            val color = node.color?.let(::resolveToneColor) ?: Palette.Text
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
            if (node.title != null) {
                Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f).height(1.dp).background(Palette.Border))
                    Text(node.title.uppercase(), style = LocalOfficeType.current.eyebrow.copy(color = Palette.TextSecondary), modifier = Modifier.padding(horizontal = 8.dp))
                    Box(Modifier.weight(1f).height(1.dp).background(Palette.Border))
                }
            } else {
                Box(Modifier.fillMaxWidth().padding(vertical = 2.dp).height(1.dp).background(Palette.Border))
            }
        }
        JsonWidget.Node.Newline -> Spacer(Modifier.height(6.dp))
        JsonWidget.Node.Spacer -> Spacer(Modifier.size(8.dp))
        is JsonWidget.Node.KeyValue -> {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
                Text(node.label, style = MaterialTheme.typography.bodySmall.copy(color = Palette.TextSecondary), modifier = Modifier.weight(1f).padding(end = 10.dp))
                Text(node.value, style = LocalOfficeType.current.monoBody.copy(fontSize = 12.5.sp, lineHeight = 18.sp, color = Palette.Text))
            }
        }
        is JsonWidget.Node.StatusLine -> {
            val dotColor = when (node.status) {
                JsonWidget.StatusKind.Success -> Palette.Success
                JsonWidget.StatusKind.Error -> Palette.Danger
                JsonWidget.StatusKind.Warning -> Palette.Warning
                JsonWidget.StatusKind.Info -> Palette.Info
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                Box(Modifier.size(6.dp).clip(CircleShape).background(dotColor))
                Text(node.text, style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.5.sp, lineHeight = 19.sp))
            }
        }
        is JsonWidget.Node.Badge -> {
            val fg = when (node.variant) {
                JsonWidget.BadgeVariant.Muted -> Palette.TextSecondary
                JsonWidget.BadgeVariant.Success -> Palette.Success
                JsonWidget.BadgeVariant.Warning -> Palette.Warning
                JsonWidget.BadgeVariant.Danger -> Palette.Danger
                JsonWidget.BadgeVariant.Info -> Palette.Info
                JsonWidget.BadgeVariant.Accent -> Palette.Accent
                JsonWidget.BadgeVariant.Default -> Palette.Text
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
                node.label?.let { Text(it.uppercase(), style = LocalOfficeType.current.eyebrow.copy(color = Palette.TextSecondary)) }
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    node.value?.let {
                        Text(it, style = LocalOfficeType.current.monoBody.copy(fontSize = 20.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold, color = Palette.Text))
                    }
                    node.trend?.let { t ->
                        val (arrow, c) = when (t) {
                            JsonWidget.Trend.Up -> "↑" to Palette.Success
                            JsonWidget.Trend.Down -> "↓" to Palette.Danger
                            JsonWidget.Trend.Flat -> "→" to Palette.TextSecondary
                        }
                        Text(arrow, style = LocalOfficeType.current.monoBody.copy(fontSize = 13.sp, color = c), modifier = Modifier.padding(bottom = 2.dp))
                    }
                }
            }
        }
        is JsonWidget.Node.ProgressBar -> {
            val mod = if (node.widthDp != null) Modifier.widthIn(max = node.widthDp.dp).fillMaxWidth() else Modifier.fillMaxWidth()
            Column(mod, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    if (node.label != null) {
                        Text(node.label, style = MaterialTheme.typography.bodySmall.copy(color = Palette.TextSecondary), modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    } else {
                        Spacer(Modifier.weight(1f))
                    }
                    Text("${node.percent}%", style = LocalOfficeType.current.eyebrow.copy(color = Palette.Text))
                }
                Box(Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(2.dp)).background(Palette.SurfaceHigh)) {
                    Box(Modifier.fillMaxWidth(node.progress).fillMaxHeight().background(Palette.Accent))
                }
            }
        }
        is JsonWidget.Node.BarChart -> {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (bar in node.bars) {
                    val c = bar.color?.let(::resolveToneColor) ?: Palette.Accent
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(bar.label, style = MaterialTheme.typography.bodySmall.copy(color = Palette.TextSecondary), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(min = 60.dp, max = 120.dp))
                        Box(Modifier.weight(1f).height(8.dp).clip(RoundedCornerShape(2.dp)).background(Palette.SurfaceHigh)) {
                            Box(Modifier.fillMaxWidth(bar.fraction).fillMaxHeight().background(c))
                        }
                        Text(bar.valueLabel, style = LocalOfficeType.current.monoBody.copy(fontSize = 11.5.sp, color = Palette.Text))
                    }
                }
            }
        }
        is JsonWidget.Node.Sparkline -> {
            val lineColor = node.color?.let(::resolveToneColor) ?: Palette.Accent
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
            val headColor = node.headerColor?.let(::resolveToneColor) ?: Palette.TextSecondary
            CodeScroll(Palette.SurfaceRaised) { scroll ->
                Column(scroll) {
                    Row(Modifier.background(Palette.SurfaceHigh)) {
                        node.columns.forEach { col ->
                            val wMod = Modifier.width((col.widthDp ?: 116).coerceIn(56, 260).dp).padding(horizontal = 8.dp, vertical = 6.dp)
                            Text(col.header.uppercase(), style = LocalOfficeType.current.eyebrow.copy(color = headColor), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = wMod)
                        }
                    }
                    node.rows.forEach { row ->
                        Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Border))
                        Row {
                            node.columns.forEachIndexed { idx, col ->
                                val wMod = Modifier.width((col.widthDp ?: 116).coerceIn(56, 260).dp).padding(horizontal = 8.dp, vertical = 6.dp)
                                Text(row.getOrElse(idx) { "" }, style = MaterialTheme.typography.bodySmall.copy(color = Palette.Text), maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = wMod)
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
                        Text(marker, style = MaterialTheme.typography.bodySmall.copy(color = Palette.TextSecondary), modifier = Modifier.width(if (node.ordered) 24.dp else 16.dp))
                        Text(item, style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.5.sp, lineHeight = 19.sp))
                    }
                }
            }
        }
        is JsonWidget.Node.Callout -> {
            val accent = when (node.tone) {
                JsonWidget.CalloutTone.Info -> Palette.Info
                JsonWidget.CalloutTone.Success -> Palette.Success
                JsonWidget.CalloutTone.Warning -> Palette.Warning
                JsonWidget.CalloutTone.Danger -> Palette.Danger
            }
            Column(
                Modifier.fillMaxWidth()
                    .panel(RoundedCornerShape(4.dp), accent.copy(alpha = 0.08f), accent.copy(alpha = 0.35f))
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                node.title?.let { Text(it, style = MaterialTheme.typography.titleSmall.copy(color = accent)) }
                node.content?.let { Text(it, style = MaterialTheme.typography.bodySmall.copy(color = Palette.Text, lineHeight = 18.sp)) }
                for (child in node.children) RenderWidgetNode(child, mono)
            }
        }
        is JsonWidget.Node.Timeline -> {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                node.items.forEach { item ->
                    val dot = when (item.status) {
                        JsonWidget.TimelineStatus.Done -> Palette.Success
                        JsonWidget.TimelineStatus.Active -> Palette.Accent
                        JsonWidget.TimelineStatus.Error -> Palette.Danger
                        JsonWidget.TimelineStatus.Pending -> Palette.TextTertiary
                    }
                    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Box(Modifier.padding(top = 6.dp).size(7.dp).clip(CircleShape).background(dot))
                        Column(Modifier.weight(1f)) {
                            Text(item.title, style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.5.sp, fontWeight = FontWeight.Medium, color = Palette.Text))
                            item.description?.let { Text(it, style = MaterialTheme.typography.bodySmall.copy(color = Palette.TextSecondary)) }
                        }
                    }
                }
            }
        }
    }
}

private fun resolveToneColor(tone: JsonWidget.ToneColor): Color = when (tone) {
    JsonWidget.ToneColor.Accent -> Palette.Accent
    JsonWidget.ToneColor.Success -> Palette.Success
    JsonWidget.ToneColor.Warning -> Palette.Warning
    JsonWidget.ToneColor.Danger -> Palette.Danger
    JsonWidget.ToneColor.Info -> Palette.Info
    JsonWidget.ToneColor.Muted -> Palette.TextSecondary
    JsonWidget.ToneColor.Purple -> Color(0xFFC084FC)
    is JsonWidget.ToneColor.Hex -> Color(tone.argb)
}

internal fun highlightedCode(text: String, language: String?): AnnotatedString {
    val tokens = Markdown.tokenizeCode(text, language)
    if (tokens.size <= 1 && tokens.firstOrNull()?.kind == Markdown.TokenKind.Plain) return AnnotatedString(text)
    return buildAnnotatedString {
        for (tok in tokens) {
            val c = when (tok.kind) {
                Markdown.TokenKind.Plain -> Palette.Text
                Markdown.TokenKind.Keyword -> Palette.AccentHover
                Markdown.TokenKind.Type -> Palette.Info
                Markdown.TokenKind.String -> Palette.Success
                Markdown.TokenKind.Number -> Palette.Warning
                Markdown.TokenKind.Comment -> Palette.TextSecondary
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
        modifier.fillMaxWidth().background(background, RoundedCornerShape(4.dp)).border(1.dp, Palette.Border, RoundedCornerShape(4.dp))
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
private fun Table(t: Markdown.Block.Table, style: TextStyle, mono: FontFamily, surface: Color, opener: ((WorkspacePaths.Ref) -> Unit)?) {
    val scroll = rememberScrollState()
    val grid = remember(t) { Grid() }
    val head = style.copy(fontWeight = FontWeight.SemiBold)
    Box(Modifier.fillMaxWidth().tagged(Tags.Worker.THREAD_TABLE)) {
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
}

/**
 * One cell. With inline code in it, the cell flows its pieces itself, breaking only between them
 * ([Markdown.unbroken]): Android's line breaker would otherwise split a path at its slashes.
 */
@Composable
private fun Cell(spans: List<Markdown.Span>, style: TextStyle, align: Markdown.Align?, mono: FontFamily, opener: ((WorkspacePaths.Ref) -> Unit)?) {
    val pad = Modifier.padding(horizontal = 10.dp, vertical = 7.dp)
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
private val fileLinkStyles = TextLinkStyles(SpanStyle(color = Palette.Accent))

private fun styled(spans: List<Markdown.Span>, mono: FontFamily, opener: ((WorkspacePaths.Ref) -> Unit)? = null): AnnotatedString = buildAnnotatedString {
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
        val file = s.file
        when {
            link != null -> withLink(LinkAnnotation.Url(link, linkStyles)) { withStyle(style) { append(s.text) } }
            file != null && opener != null -> withLink(LinkAnnotation.Clickable("file:${file.label}", fileLinkStyles) { opener(file) }) { withStyle(style) { append(s.text) } }
            else -> withStyle(style) { append(s.text) }
        }
    }
}
