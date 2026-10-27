package ai.factory.droidoffice.ui.worker

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
                is Markdown.Block.Code -> Box(
                    Modifier.fillMaxWidth().background(Palette.Surface, RoundedCornerShape(8.dp)).border(1.dp, Palette.Border, RoundedCornerShape(8.dp)),
                ) {
                    Text(
                        b.text,
                        style = LocalOfficeType.current.monoBody.copy(fontSize = 12.5.sp, lineHeight = 18.sp),
                        softWrap = false,
                        modifier = Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 10.dp, vertical = 8.dp),
                    )
                }
                Markdown.Block.Rule -> Box(Modifier.fillMaxWidth().padding(vertical = 4.dp).height(1.dp).background(Palette.Border))
            }
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
