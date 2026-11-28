package ai.factory.droidoffice.ui.worker

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.ThreadEntry
import ai.factory.droidoffice.core.ThreadTurns
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.ThreadPalette
import kotlinx.coroutines.launch

/** Droid's side chat (/btw) over the composer while the terminal shows it: its question and answer, and a close. */
@Composable
internal fun ThreadSideChat(text: String, onClose: (() -> Unit)?) {
    val shape = RoundedCornerShape(4.dp)
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier.widthIn(max = READING_WIDTH + 20.dp).fillMaxWidth().padding(start = 10.dp, end = 10.dp, bottom = 8.dp)
                .background(ThreadPalette.Surface, shape).border(1.dp, ThreadPalette.InputBorder, shape).padding(start = 12.dp, bottom = 10.dp)
                .tagged(Tags.Worker.THREAD_SIDE),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Side chat", style = MaterialTheme.typography.bodyMedium.copy(color = ThreadPalette.Text))
                Text(
                    "Ask a follow-up with /btw",
                    style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, color = ThreadPalette.TextTertiary),
                    maxLines = 1,
                    modifier = Modifier.weight(1f).padding(start = 8.dp),
                )
                if (onClose != null) IconButton(onClick = onClose, modifier = Modifier.tagged(Tags.Worker.THREAD_SIDE_CLOSE)) {
                    Icon(Icons.Default.Close, "Close side chat", Modifier.size(16.dp), tint = ThreadPalette.TextSecondary)
                }
            }
            Text(
                text.ifBlank { "Thinking…" },
                style = MaterialTheme.typography.bodyMedium.copy(color = ThreadPalette.Text),
                modifier = Modifier.heightIn(max = 220.dp).verticalScroll(rememberScrollState()).padding(end = 12.dp),
            )
        }
    }
}

/** Droid's /copy menu: a reply, a prompt, the session id, the transcript or the last turns, to the clipboard. */
@Composable
internal fun ThreadCopyDialog(entries: List<ThreadEntry>, sessionId: String?, onDismiss: () -> Unit) {
    val clipboard = LocalClipboard.current
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()
    var turns by remember { mutableStateOf("1") }
    fun pick(choice: ThreadTurns.Copy) {
        val text = ThreadTurns.copyText(entries, choice, sessionId, turns.toIntOrNull() ?: 1)
        scope.launch {
            if (text == null) {
                snackbar.showSnackbar(if (choice == ThreadTurns.Copy.Session) "This worker has no session yet." else "Nothing to copy yet.")
            } else {
                val copied = runCatching { clipboard.setClipEntry(workerTextClip(choice.label, text)) }.isSuccess
                if (copied) onDismiss() else snackbar.showSnackbar("Couldn't copy to the clipboard.")
            }
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = ThreadPalette.Surface,
        titleContentColor = ThreadPalette.Text,
        title = { Text("Copy") },
        text = {
            Column(Modifier.fillMaxWidth().tagged(Tags.Worker.THREAD_COPY), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                for (choice in ThreadTurns.Copy.entries) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        TextButton(onClick = { pick(choice) }, modifier = Modifier.tagged(Tags.Worker.copyChoice(choice.name))) { Text(choice.label, color = ThreadPalette.Accent) }
                        if (choice == ThreadTurns.Copy.Turns) {
                            Text("Last", color = ThreadPalette.TextSecondary, modifier = Modifier.padding(horizontal = 6.dp))
                            OutlinedTextField(
                                value = turns,
                                onValueChange = { next -> turns = next.filter(Char::isDigit).take(4) },
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                modifier = Modifier.width(72.dp),
                            )
                            Text("turns", color = ThreadPalette.TextSecondary, modifier = Modifier.padding(horizontal = 6.dp))
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = ThreadPalette.TextSecondary) } },
    )
}
