package ai.factory.droidoffice.ui.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.WorkerActions
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.session.Phase
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.Palette
import ai.factory.droidoffice.ui.worker.ForkWorkerDialog
import ai.factory.droidoffice.ui.worker.SendHomeDialog

/** Only the two card actions. Confirmation, eligibility and receipts belong to their dialogs. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkerActionsSheet(worker: WorkerInfo, onDismiss: () -> Unit) {
    val connection = LocalGraph.current.connection
    val link by connection.link.collectAsStateWithLifecycle()
    val data by connection.data.collectAsStateWithLifecycle()
    var action by remember(worker.id) { mutableStateOf<String?>(null) }
    val live = link.phase == Phase.Connected && data.synced
    val refusal = if (!live) "Disconnected. Reconnect to use worker actions." else WorkerActions.forkRefusal(worker)

    when (action) {
        "fork" -> ForkWorkerDialog(worker, onDismiss)
        "dismiss" -> SendHomeDialog(worker, onDismiss, onDismiss)
        else -> ModalBottomSheet(
            onDismissRequest = onDismiss,
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = Palette.SurfaceRaised,
            contentColor = Palette.Text,
            shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp),
            modifier = Modifier.tagged(Tags.WorkerActions.SHEET),
        ) {
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(worker.name.ifBlank { worker.id }, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(bottom = 12.dp).tagged(Tags.WorkerActions.NAME))
                TextButton(
                    enabled = refusal == null,
                    onClick = {
                        val current = connection.data.value.workers[worker.id]
                        if (connection.connected && current != null && WorkerActions.forkRefusal(current) == null) action = "fork"
                    },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).tagged(Tags.WorkerActions.FORK),
                ) { Text("FORK", color = if (refusal == null) Palette.Text else Palette.TextSecondary) }
                if (refusal != null) Text(refusal, style = MaterialTheme.typography.bodySmall, color = Palette.TextSecondary, modifier = Modifier.tagged(Tags.WorkerActions.FORK_REASON))
                TextButton(
                    enabled = live,
                    onClick = { if (connection.connected && connection.data.value.workers.containsKey(worker.id)) action = "dismiss" },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).tagged(Tags.WorkerActions.DISMISS),
                ) { Text("DISMISS", color = if (live) Palette.Danger else Palette.TextSecondary) }
            }
        }
    }
}
