package ai.factory.droidoffice.ui.worker

import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.FactoryCloud
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.WorkerActions
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.core.WorktreeState
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.session.Phase
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.home.deskLabel
import ai.factory.droidoffice.ui.theme.Palette
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.launch
import java.util.UUID

/** What deleting the worktree would lose, as the office's own send-home dialog words it (src/client/ui/prompt.ts). */
fun describeWorktree(s: WorktreeState, branch: String): Pair<List<String>, Boolean> {
    if (s.error != null) return listOf("Couldn't check the worktree: ${s.error}.") to true
    val lines = mutableListOf<String>()
    var risky = false
    if (!s.exists) lines += "The worktree folder is already gone."
    if (s.dirty > 0) {
        lines += "⚠️ ${plural(s.dirty, "uncommitted change")} in the worktree. Deleting it loses them."
        risky = true
    }
    if (s.unpushed > 0) {
        lines += "⚠️ ${plural(s.unpushed, "commit")} on $branch that no remote has. Deleting the branch loses them."
        risky = true
    } else if (s.ahead > 0) lines += "${plural(s.ahead, "commit")} on $branch, all pushed or merged."
    if (lines.isEmpty()) lines += "Nothing on the branch yet and a clean worktree: safe to delete."
    return lines to risky
}

private fun plural(n: Int, noun: String) = "$n $noun${if (n == 1) "" else "s"}"

@Composable
fun SendHomeDialog(w: WorkerInfo, onDismiss: () -> Unit, onSent: () -> Unit) {
    val graph = LocalGraph.current
    val data by graph.connection.data.collectAsStateWithLifecycle()
    val link by graph.connection.link.collectAsStateWithLifecycle()
    val floor = remember(w.id) { data.workerFloorId(w.id) ?: data.floorId }
    val office = remember(w.id) { data.officeId }
    val scope = rememberCoroutineScope()
    var pending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val wt = w.worktree?.takeIf { it.branch.isNotBlank() }
    var cleanup by remember(w.id, wt) { mutableStateOf("keep") }
    var status by remember(w.id, wt) { mutableStateOf<Pair<List<String>, Boolean>?>(null) }
    var deleteSession by remember(w.id) { mutableStateOf(false) }

    if (wt != null) {
        LaunchedEffect(w.id, wt) {
            val state = coroutineScope {
                val answer = async(start = CoroutineStart.UNDISPATCHED) { graph.connection.worktrees.first { it.workerId == w.id } }
                graph.connection.send(ClientMsg.worktree(w.id))
                withTimeoutOrNull(8_000) { answer.await() }.also { answer.cancel() }
            }
            val described = describeWorktree(state?.state ?: WorktreeState(error = "the office did not answer"), wt.branch)
            status = described
        }
    }

    val labels = mapOf("keep" to "Send home", "worktree" to "Send home, delete worktree", "all" to "Send home, delete both")
    val currentFloor = data.workerFloorId(w.id)
    val floorGone = floor == null || (data.floors.isNotEmpty() && data.floors.none { it.id == floor }) || (currentFloor != null && currentFloor != floor)
    val refusal = when {
        link.phase != Phase.Connected -> "Disconnected. Nothing can be sent."
        data.officeId != office || floorGone -> "The active floor changed. Nothing was sent."
        data.deskWorker(w.id) == null -> "The worker has left."
        else -> null
    }
    AlertDialog(
        onDismissRequest = { if (!pending) onDismiss() },
        modifier = Modifier.tagged(Tags.SendHome.DIALOG),
        containerColor = Palette.SurfaceRaised,
        shape = RoundedCornerShape(16.dp),
        title = { Text("Send ${w.name} home?", style = MaterialTheme.typography.headlineSmall) },
        text = {
            // Scrolls so the choices stay reachable at a large font size or in landscape.
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(
                    if (w.isCloud) FactoryCloud.sendHome(w)
                    else "This stops the session at ${deskLabel(w.deskId)} for everyone and frees the desk." + if (wt != null) " ${w.name} worked in its own worktree on 🌿 ${wt.branch}:" else "",
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (w.isCloud) {
                    Spacer(Modifier.height(10.dp))
                    Row(
                        Modifier.fillMaxWidth().toggleable(deleteSession, enabled = !pending, role = Role.Switch) { deleteSession = it }.tagged(Tags.SendHome.DELETE_SESSION).padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text("Also delete its Factory session", style = MaterialTheme.typography.titleSmall)
                            Text("Its transcript and settings go with it", style = MaterialTheme.typography.bodySmall)
                        }
                        Switch(
                            checked = deleteSession,
                            onCheckedChange = null,
                            colors = SwitchDefaults.colors(checkedTrackColor = Palette.Danger, checkedThumbColor = Palette.Bg, uncheckedTrackColor = Palette.SurfaceHigh, uncheckedBorderColor = Palette.BorderStrong),
                        )
                    }
                }
                if (wt != null) {
                    Spacer(Modifier.height(10.dp))
                    listOf(
                        Triple("all", "Delete the worktree and its branch", "Removes ${wt.path} and ${wt.branch}."),
                        Triple("worktree", "Delete the worktree, keep the branch", "${wt.branch} stays for a pull request or a later checkout."),
                        Triple("keep", "Keep both", "Leaves everything as it is; droid-office prune tidies up later."),
                    ).forEach { (value, title, sub) ->
                        Row(
                            Modifier.fillMaxWidth().selectable(cleanup == value, enabled = !pending, role = Role.RadioButton) { cleanup = value }.tagged(Tags.SendHome.option(value)).padding(vertical = 4.dp),
                            verticalAlignment = Alignment.Top,
                        ) {
                            RadioButton(cleanup == value, null, colors = RadioButtonDefaults.colors(selectedColor = Palette.Accent))
                            Column(Modifier.padding(top = 10.dp)) {
                                Text(title, style = MaterialTheme.typography.titleSmall)
                                Text(sub, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    val s = status
                    if (s == null) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Spinner(Modifier.size(12.dp), Palette.TextSecondary)
                            Spacer(Modifier.size(8.dp))
                            Text("Checking what ${wt.branch} holds…", style = MaterialTheme.typography.bodySmall)
                        }
                    } else {
                        s.first.forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = if (s.second) Palette.Warning else Palette.TextSecondary) }
                    }
                }
                (refusal ?: error)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.Warning, modifier = Modifier.tagged(Tags.SendHome.ERROR)) }
            }
        },
        confirmButton = {
            TextButton(enabled = !pending && refusal == null && (cleanup == "keep" || status != null), onClick = {
                val latest = graph.connection.data.value
                val latestFloor = latest.workerFloorId(w.id) ?: latest.floorId
                if (!graph.connection.connected || latestFloor != floor || latest.officeId != office || latest.deskWorker(w.id) == null) return@TextButton
                pending = true
                error = null
                scope.launch {
                    val id = UUID.randomUUID().toString()
                    val result = WorkerActions.confirm(onFinished = { pending = false }) {
                        graph.connection.actionConfirmed(id, ClientMsg.kill(w.id, if (wt != null) cleanup else null, deleteSession = w.isCloud && deleteSession, requestId = id, floor = floor))
                    }
                    if (result?.ok == true) onSent()
                    else error = result?.error ?: "Dismissal could not be confirmed. Check the floor before trying again. Nothing will be resent automatically."
                }
            }, modifier = Modifier.tagged(Tags.SendHome.CONFIRM)) { Text(if (pending) "Sending home…" else labels.getValue(if (wt != null) cleanup else "keep"), color = if (pending || refusal != null) Palette.TextSecondary else Palette.Danger) }
        },
        dismissButton = { TextButton(enabled = !pending, onClick = onDismiss, modifier = Modifier.tagged(Tags.SendHome.CANCEL)) { Text("Never mind", color = Palette.TextSecondary) } },
    )
}
