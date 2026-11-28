package ai.factory.droidoffice.ui.worker

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.ThreadActions
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.ThreadPalette
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The touch equivalent of Factory's hover bar under a message: Rewind, Copy, Quote and its time. */
@Composable
internal fun ThreadMessageActions(
    id: String,
    text: String,
    at: Long?,
    user: Boolean,
    onQuote: ((String) -> Unit)?,
    onRewind: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var copied by remember(id) { mutableStateOf(false) }
    var now by remember(id) { mutableLongStateOf(workerNowMillis()) }
    LaunchedEffect(id, at) {
        while (at != null) {
            delay(60_000)
            now = workerNowMillis()
        }
    }
    Row(modifier.heightIn(min = 32.dp), verticalAlignment = Alignment.CenterVertically) {
        if (user && onRewind != null) {
            MessageAction(OfficeIcons.Rewind, "Rewind conversation to this message", Tags.Worker.threadMessageRewind(id), onRewind)
        }
        MessageAction(if (copied) OfficeIcons.Check else OfficeIcons.Copy, "Copy message", Tags.Worker.threadMessageCopy(id)) {
            scope.launch {
                clipboard.setClipEntry(workerTextClip("Message", text))
                copied = true
                delay(2_000)
                copied = false
            }
        }
        if (!user && onQuote != null) {
            MessageAction(OfficeIcons.Quote, "Quote message", Tags.Worker.threadMessageQuote(id)) { onQuote(text) }
        }
        if (at != null) {
            Text(
                ThreadActions.ago(at, now),
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp, lineHeight = 14.sp, color = ThreadPalette.TextTertiary),
                modifier = Modifier.padding(start = 8.dp, end = 4.dp).tagged(Tags.Worker.threadMessageTime(id)),
            )
        }
    }
}

@Composable
private fun MessageAction(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, tag: String, onClick: () -> Unit) {
    Row(
        Modifier.clip(RoundedCornerShape(4.dp)).clickable(role = Role.Button, onClickLabel = label, onClick = onClick)
            .tagged(tag).size(32.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, label, Modifier.size(32.dp).padding(8.dp), tint = ThreadPalette.TextSecondary)
    }
}
