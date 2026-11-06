package ai.factory.droidoffice.ui.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.WorkerActions
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.session.Phase
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.components.parseColor
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
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
    val current = data.workers[worker.id]
    val refusal = when {
        !live -> "Disconnected. Reconnect to use worker actions."
        current == null -> "The worker has left."
        else -> WorkerActions.forkRefusal(current)
    }

    when (action) {
        "fork" -> ForkWorkerDialog(worker, onDismiss)
        "dismiss" -> SendHomeDialog(worker, onDismiss, onDismiss)
        else -> ModalBottomSheet(
            onDismissRequest = onDismiss,
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = Palette.SurfaceRaised,
            contentColor = Palette.Text,
            shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
            tonalElevation = 0.dp,
            modifier = Modifier.tagged(Tags.WorkerActions.SHEET),
        ) {
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 20.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Box(Modifier.size(44.dp).clip(RoundedCornerShape(12.dp)).background(Palette.SurfaceHigh).border(1.dp, Palette.Border, RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
                        Icon(if (worker.isShell) OfficeIcons.Shell else OfficeIcons.Agent, null, Modifier.size(24.dp), tint = parseColor(worker.color))
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(worker.name.ifBlank { worker.id }, style = MaterialTheme.typography.headlineSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.tagged(Tags.WorkerActions.NAME))
                        Text("Worker actions", style = MaterialTheme.typography.bodySmall)
                    }
                }
                Column(Modifier.clip(RoundedCornerShape(12.dp)).background(Palette.SurfaceHover).border(1.dp, Palette.Border, RoundedCornerShape(12.dp))) {
                    WorkerActionRow(
                        label = "FORK",
                        description = refusal ?: "Continue in a new worker",
                        icon = OfficeIcons.Branch,
                        enabled = refusal == null,
                        tag = Tags.WorkerActions.FORK,
                        descriptionTag = if (refusal != null) Tags.WorkerActions.FORK_REASON else null,
                        onClick = {
                            val latest = connection.data.value.workers[worker.id]
                            if (connection.connected && latest != null && WorkerActions.forkRefusal(latest) == null) action = "fork"
                        },
                    )
                    HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = Palette.Border)
                    WorkerActionRow(
                        label = "DISMISS",
                        description = "Remove from this floor",
                        icon = OfficeIcons.Door,
                        enabled = live,
                        tag = Tags.WorkerActions.DISMISS,
                        color = Palette.Danger,
                        onClick = { if (connection.connected && connection.data.value.workers.containsKey(worker.id)) action = "dismiss" },
                    )
                }
            }
        }
    }
}

@Composable
private fun WorkerActionRow(label: String, description: String, icon: ImageVector, enabled: Boolean, tag: String, onClick: () -> Unit, color: Color = Palette.Text, descriptionTag: String? = null) {
    val ink = if (enabled) color else Palette.TextSecondary
    Row(
        Modifier.fillMaxWidth().heightIn(min = 80.dp).clickable(enabled = enabled, role = Role.Button, onClick = onClick).tagged(tag).padding(horizontal = 16.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Icon(icon, null, Modifier.size(22.dp), tint = ink)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(label, style = LocalOfficeType.current.eyebrow.copy(fontSize = 13.sp, color = ink))
            Text(description, style = MaterialTheme.typography.bodySmall, modifier = if (descriptionTag != null) Modifier.tagged(descriptionTag) else Modifier)
        }
        Icon(OfficeIcons.Chevron, null, Modifier.size(18.dp), tint = if (enabled) Palette.TextSecondary else Palette.TextTertiary)
    }
}
