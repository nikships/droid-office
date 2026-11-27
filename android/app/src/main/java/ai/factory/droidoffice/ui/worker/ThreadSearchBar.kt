package ai.factory.droidoffice.ui.worker

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.ThreadPalette

/** Factory's "Search session" bar over the transcript. */
@Composable
internal fun ThreadSearchBar(
    query: String,
    active: Int,
    count: Int,
    onQuery: (String) -> Unit,
    onStep: (Int) -> Unit,
    onClose: () -> Unit,
    terminal: Boolean = false,
    status: String? = null,
) {
    val label = if (terminal) "Find in terminal" else "Search session"
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    Row(
        Modifier.fillMaxWidth().background(ThreadPalette.Surface).padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(OfficeIcons.Search, null, Modifier.size(16.dp), tint = ThreadPalette.TextSecondary)
        Box(Modifier.weight(1f).padding(horizontal = 10.dp), contentAlignment = Alignment.CenterStart) {
            if (query.isEmpty()) Text(label, style = MaterialTheme.typography.bodyMedium, color = ThreadPalette.TextTertiary)
            BasicTextField(
                value = query,
                onValueChange = onQuery,
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, color = ThreadPalette.Text),
                cursorBrush = SolidColor(ThreadPalette.Accent),
                modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = label }.tagged(if (terminal) Tags.Worker.TERM_FIND_FIELD else Tags.Worker.THREAD_SEARCH_FIELD),
            )
        }
        Text(
            status ?: if (count == 0) "No results" else "${active + 1} of $count",
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, color = ThreadPalette.TextSecondary),
            modifier = Modifier.tagged(if (terminal) Tags.Worker.TERM_FIND_COUNT else Tags.Worker.THREAD_SEARCH_COUNT),
        )
        val target = if (terminal) "terminal" else "chat"
        SearchAction(OfficeIcons.ArrowUp, "Previous $target search match", if (terminal) Tags.Worker.TERM_FIND_PREV else Tags.Worker.THREAD_SEARCH_PREV, count > 0) { onStep(-1) }
        SearchAction(OfficeIcons.ArrowDown, "Next $target search match", if (terminal) Tags.Worker.TERM_FIND_NEXT else Tags.Worker.THREAD_SEARCH_NEXT, count > 0) { onStep(1) }
        SearchAction(Icons.Default.Close, "Close $target search", if (terminal) Tags.Worker.TERM_FIND_CLOSE else Tags.Worker.THREAD_SEARCH_CLOSE, true, onClose)
    }
    Box(Modifier.fillMaxWidth().height(1.dp).background(ThreadPalette.Border))
}

@Composable
private fun SearchAction(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, tag: String, enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.size(36.dp).clip(RoundedCornerShape(4.dp)).clickable(enabled = enabled, role = Role.Button, onClickLabel = label, onClick = onClick).tagged(tag),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, label, Modifier.size(15.dp), tint = if (enabled) ThreadPalette.TextSecondary else ThreadPalette.TextTertiary)
    }
}
