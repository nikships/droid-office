package ai.factory.droidoffice.ui.board

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.PingCheck
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.WhiteboardPing
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.StatusPill
import ai.factory.droidoffice.ui.components.WorkerDot
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.parseColor
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.home.rememberNow
import ai.factory.droidoffice.ui.theme.Palette
import kotlinx.coroutines.launch

/**
 * Ping a worker: pick one of the floor's workers and the office types the Whiteboard line into its
 * terminal, as its status allows. Rows that can't take it say why; the list follows status changes.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PingSheet(onDismiss: () -> Unit) {
    val graph = LocalGraph.current
    val snackbar = LocalSnackbar.current
    val connection = graph.connection
    val data by connection.data.collectAsStateWithLifecycle()
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val now = rememberNow(5_000)
    val rows = WhiteboardPing.order(data.workers.values, now)

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, containerColor = Palette.Surface, shape = RoundedCornerShape(topStart = 22.dp, topEnd = 22.dp)) {
        Column(Modifier.fillMaxWidth().tagged(Tags.Board.PING_SHEET).padding(horizontal = 20.dp).navigationBarsPadding().padding(bottom = 14.dp)) {
            Eyebrow("Ping a worker", color = Palette.Accent)
            Spacer(Modifier.height(4.dp))
            Text("Who should look at the board?", style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.height(4.dp))
            Text("The office types a line into its terminal telling it to read the Whiteboard.", style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(14.dp))
            if (rows.isEmpty()) {
                Text("Nobody works on this floor yet.", style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary, modifier = Modifier.padding(vertical = 18.dp))
            }
            LazyColumn(Modifier.heightIn(max = 520.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(rows, key = { it.first.id }) { (w, check) ->
                    val ok = check is PingCheck.Ok
                    Row(
                        Modifier.fillMaxWidth()
                            .panel(RoundedCornerShape(12.dp), Palette.SurfaceRaised, Palette.Border)
                            .clickable(enabled = ok, onClickLabel = "Ping ${w.name}") {
                                if (connection.pingBoard(w.id)) {
                                    scope.launch { sheet.hide() }.invokeOnCompletion { onDismiss() }
                                } else {
                                    scope.launch { snackbar.showSnackbar("Not connected to the office") }
                                }
                            }
                            .tagged(Tags.Board.pingWorker(w.id))
                            .padding(start = 6.dp, end = 12.dp, top = 10.dp, bottom = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        WorkerDot(parseColor(w.color), w.state, 10.dp)
                        Column(Modifier.weight(1f).padding(start = 2.dp, end = 8.dp)) {
                            Text(w.name.ifBlank { w.id }, style = MaterialTheme.typography.titleSmall, color = if (ok) Palette.Text else Palette.TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            val on = listOfNotNull(WhiteboardPing.doing(w), w.worktree?.branch?.takeIf { it.isNotBlank() }?.let { "🌿 $it" }, w.pr?.number?.takeIf { it > 0 }?.let { "#$it" })
                            Text(on.joinToString(" · "), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (check is PingCheck.No) Text(check.reason, style = MaterialTheme.typography.bodySmall, color = if (check.busy) Palette.Warning else Palette.TextTertiary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        StatusPill(w.state, acked = w.acked)
                    }
                }
            }
        }
    }
}
