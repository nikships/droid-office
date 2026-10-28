package ai.factory.droidoffice.ui.offices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import ai.factory.droidoffice.core.HostUpdateState
import ai.factory.droidoffice.core.HostUpdateAction
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.SecondaryButton
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.Palette
import kotlinx.coroutines.delay
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch

/** Polling lasts only while visible. Dismissal never cancels an update on the Mac. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HostUpdateSheet(officeId: String, onDismiss: () -> Unit) {
    val connection = LocalGraph.current.connection
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    var state by remember(officeId) { mutableStateOf<HostUpdateState?>(null) }
    var error by remember(officeId) { mutableStateOf<String?>(null) }
    var pending by remember(officeId) { mutableStateOf(false) }
    var confirm by remember(officeId) { mutableStateOf<String?>(null) }

    suspend fun request(action: HostUpdateAction? = null, version: String? = null): Boolean {
        if (pending) return false
        pending = true
        try {
            connection.hostUpdate(officeId, action, version).fold(
                onSuccess = { state = it; error = null },
                onFailure = {
                    error = if (state?.restarting == true) "Waiting for the host to restart. This view reconnects automatically."
                        else it.message ?: "Could not reach the host. Reconnecting…"
                },
            )
        } finally {
            pending = false
        }
        return true
    }

    LaunchedEffect(officeId, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                if (confirm == null) request()
                delay(2000)
            }
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Palette.Surface) {
        Column(Modifier.fillMaxWidth().tagged(Tags.HostUpdate.SHEET).verticalScroll(rememberScrollState()).navigationBarsPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Row(Modifier.fillMaxWidth()) {
                Text("Host desktop app", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
                TextButton(onClick = onDismiss, modifier = Modifier.tagged(Tags.HostUpdate.CLOSE)) { Text("Done") }
            }
            Text("Update the Mac app that runs this office, not this phone.", style = MaterialTheme.typography.bodyMedium)
            val s = state
            Column(Modifier.tagged(Tags.HostUpdate.STATUS), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(s?.title ?: "Reading host update status…", style = MaterialTheme.typography.titleMedium)
                s?.currentVersion?.takeIf { it.isNotBlank() }?.let { Text("Host version $it", style = MaterialTheme.typography.bodySmall) }
                s?.detail?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                if (s?.busy == true) {
                    val progress = s.progress
                    if (progress == null) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    else LinearProgressIndicator(progress = { progress.coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                }
                error?.let { Text(it, color = Palette.Warning, modifier = Modifier.tagged(Tags.HostUpdate.ERROR)) }
            }
            SecondaryButton("Check for updates", { scope.launch(start = CoroutineStart.UNDISPATCHED) { request(HostUpdateAction.CHECK) } }, Modifier.fillMaxWidth().tagged(Tags.HostUpdate.CHECK), enabled = !pending && s?.supported != false && s?.busy != true)
            if (s?.canInstall == true && s.version != null) {
                SecondaryButton("Install and restart", { if (!pending) confirm = state?.version }, Modifier.fillMaxWidth().tagged(Tags.HostUpdate.INSTALL), enabled = !pending && error == null && s.supported && !s.busy)
            }
        }
    }
    confirm?.let { version ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            modifier = Modifier.tagged(Tags.HostUpdate.CONFIRM_DIALOG),
            containerColor = Palette.SurfaceRaised,
            title = { Text("Update host desktop app?") },
            text = { Text("Install Droid Office $version on the host Mac and restart it? Workers keep running. This phone disconnects briefly and reconnects when the office returns.") },
            confirmButton = { TextButton(onClick = { scope.launch(start = CoroutineStart.UNDISPATCHED) { if (request(HostUpdateAction.INSTALL, version)) confirm = null } }, enabled = !pending, modifier = Modifier.tagged(Tags.HostUpdate.CONFIRM)) { Text("Install and restart") } },
            dismissButton = { TextButton(onClick = { confirm = null }, modifier = Modifier.tagged(Tags.HostUpdate.CANCEL)) { Text("Cancel") } },
        )
    }
}
