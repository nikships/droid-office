package ai.factory.droidoffice.ui.worker

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.WorkerActions
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.session.Phase
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.Palette
import java.util.UUID
import kotlinx.coroutines.launch

@Composable
fun ForkWorkerDialog(worker: WorkerInfo, onDismiss: () -> Unit) {
    val graph = LocalGraph.current
    val connection = graph.connection
    val data by connection.data.collectAsStateWithLifecycle()
    val link by connection.link.collectAsStateWithLifecycle()
    val floor = remember(worker.id) { data.floorId }
    val office = remember(worker.id) { data.officeId }
    val plain = data.floor?.plain == true || data.floor?.home == true
    var prompt by rememberSaveable(worker.id) { mutableStateOf("") }
    var pending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val snackbar = LocalSnackbar.current
    val current = data.workers[worker.id]
    val refusal = when {
        link.phase != Phase.Connected -> "Disconnected. Nothing can be sent."
        data.floorId != floor || data.officeId != office -> "The active floor changed. Nothing was sent."
        current == null -> "The source worker has left"
        else -> WorkerActions.forkRefusal(current)
    }

    AlertDialog(
        onDismissRequest = { if (!pending) onDismiss() },
        modifier = Modifier.tagged(Tags.Fork.DIALOG),
        containerColor = Palette.SurfaceRaised,
        shape = RoundedCornerShape(16.dp),
        title = { Text("Fork ${worker.name}?", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    if (plain) "The twin gets a separate copy of this worker's conversation in the same folder. Both workers share files, so their edits affect each other."
                    else "The twin gets this worker's conversation, current commit, staged and unstaged edits, and untracked files in a separate worktree. The original stays untouched.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text("The twin counts toward your worker limit and takes the nearest free desk.", style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(
                    value = prompt,
                    onValueChange = { if (it.length <= 20_000) prompt = it },
                    enabled = !pending,
                    label = { Text("New direction (optional)") },
                    supportingText = { Text("Leave blank to open the fork without starting a turn.") },
                    modifier = Modifier.fillMaxWidth().tagged(Tags.Fork.PROMPT),
                )
                (refusal ?: error)?.let {
                    Text(it, color = Palette.Warning, style = MaterialTheme.typography.bodySmall, modifier = Modifier.tagged(Tags.Fork.ERROR).semantics { liveRegion = LiveRegionMode.Polite })
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !pending && refusal == null,
                onClick = {
                    val latest = connection.data.value
                    val source = latest.workers[worker.id]
                    if (!connection.connected || latest.floorId != floor || latest.officeId != office || source == null || WorkerActions.forkRefusal(source) != null) return@TextButton
                    pending = true
                    error = null
                    scope.launch {
                        val id = UUID.randomUUID().toString()
                        val result = WorkerActions.confirm(onFinished = { pending = false }) {
                            connection.actionConfirmed(id, ClientMsg.fork(worker.id, prompt, id, floor))
                        }
                        if (result?.ok == true) {
                            onDismiss()
                            graph.scope.launch { snackbar.showSnackbar("Fork created at the nearest free seat") }
                        } else error = result?.error ?: "The fork could not be confirmed. Check the floor before trying again. Nothing will be resent automatically."
                    }
                },
                modifier = Modifier.tagged(Tags.Fork.CONFIRM),
            ) { Text(if (pending) "Forking…" else "Fork worker", color = if (pending || refusal != null) Palette.TextSecondary else Palette.Accent) }
        },
        dismissButton = { TextButton(enabled = !pending, onClick = onDismiss, modifier = Modifier.tagged(Tags.Fork.CANCEL)) { Text("Cancel", color = Palette.TextSecondary) } },
    )
}
