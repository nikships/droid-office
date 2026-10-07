package ai.factory.droidoffice.ui.home

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.Effort
import ai.factory.droidoffice.core.Workers
import ai.factory.droidoffice.net.ModelCatalogue
import ai.factory.droidoffice.net.ModelOption
import ai.factory.droidoffice.session.Phase
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.components.Chip
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.PrimaryButton
import ai.factory.droidoffice.ui.components.SecondaryButton
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import kotlinx.coroutines.launch

/** Hire a worker at the next free desk: a Droid agent with a task (or none yet), or a plain shell. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HireSheet(onDismiss: () -> Unit) {
    val graph = LocalGraph.current
    val snackbar = LocalSnackbar.current
    val connection = graph.connection
    val link by connection.link.collectAsStateWithLifecycle()
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()

    var shell by rememberSaveable { mutableStateOf(false) }
    var prompt by rememberSaveable { mutableStateOf("") }
    var worktree by rememberSaveable { mutableStateOf(true) }
    var modelId by rememberSaveable { mutableStateOf<String?>(null) }
    var effort by rememberSaveable { mutableStateOf<String?>(null) }
    var catalogue by remember { mutableStateOf<ModelCatalogue?>(null) }
    var loadingModels by remember { mutableStateOf(true) }

    LaunchedEffect(link.phase) {
        if (link.phase != Phase.Connected || catalogue != null) return@LaunchedEffect
        loadingModels = true
        catalogue = connection.models()
        loadingModels = false
        val c = catalogue ?: return@LaunchedEffect
        if (modelId == null) modelId = c.defaultModel ?: c.models.firstOrNull { !it.legacy }?.id
        if (effort == null) effort = c.models.firstOrNull { it.id == modelId }?.defaultReasoningEffort ?: c.defaultReasoningEffort
    }
    val model = catalogue?.models?.firstOrNull { it.id == modelId }
    val efforts = model?.supportedReasoningEfforts?.mapNotNull(Effort::of).orEmpty()

    fun close() {
        scope.launch { sheet.hide() }.invokeOnCompletion { onDismiss() }
    }

    fun hire(queue: Boolean) {
        val kind = if (shell) "shell" else "agent"
        val e = effort?.takeIf { w -> efforts.isEmpty() || efforts.any { it.wire == w } }
        val ok = if (queue) connection.send(ClientMsg.queueAdd(prompt.trim(), modelId, e))
        else connection.hire(prompt.trim().takeIf { !shell && it.isNotBlank() }, kind, modelId, e, worktree)
        if (ok) {
            if (queue) scope.launch { snackbar.showSnackbar("Added to the queue") }
            close()
        } else {
            scope.launch { snackbar.showSnackbar("Not connected to the office yet") }
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, containerColor = Palette.Surface, shape = RoundedCornerShape(topStart = 22.dp, topEnd = 22.dp)) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).navigationBarsPadding().imePadding().padding(bottom = 14.dp),
        ) {
            Eyebrow("Hire", color = Palette.Accent)
            Spacer(Modifier.height(4.dp))
            Text("Who's starting?", style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.height(14.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                KindCard(OfficeIcons.Agent, "Droid", "An agent with a task", !shell, Modifier.weight(1f)) { shell = false }
                KindCard(OfficeIcons.Shell, "Shell", "A plain terminal", shell, Modifier.weight(1f)) { shell = true }
            }
            AnimatedVisibility(!shell) {
                Column {
                    Spacer(Modifier.height(16.dp))
                    OutlinedTextField(
                        value = prompt,
                        onValueChange = { prompt = it },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 110.dp),
                        placeholder = { Text("What should it work on? Leave it empty to brief it later.", color = Palette.TextTertiary) },
                        textStyle = MaterialTheme.typography.bodyLarge,
                        shape = RoundedCornerShape(12.dp),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Palette.Accent, unfocusedBorderColor = Palette.BorderStrong, cursorColor = Palette.Accent),
                    )
                    Spacer(Modifier.height(16.dp))
                    Eyebrow("Model")
                    Spacer(Modifier.height(6.dp))
                    ModelPicker(catalogue, loadingModels && link.phase == Phase.Connected, modelId) { m ->
                        modelId = m.id
                        effort = m.defaultReasoningEffort ?: effort
                    }
                    if (efforts.isNotEmpty()) {
                        Spacer(Modifier.height(14.dp))
                        Eyebrow("Reasoning")
                        Spacer(Modifier.height(6.dp))
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            efforts.forEach { e -> Chip(e.label, effort == e.wire, { effort = e.wire }) }
                        }
                    }
                }
            }
            Spacer(Modifier.height(16.dp))
            Row(
                Modifier.fillMaxWidth().panel(RoundedCornerShape(12.dp), Palette.SurfaceRaised).clickable { worktree = !worktree }.padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(OfficeIcons.Branch, null, Modifier.size(18.dp), tint = Palette.TextSecondary)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text("Its own worktree", style = MaterialTheme.typography.titleSmall)
                    Text(if (worktree) "A fresh branch, so its changes never touch yours" else "Works in the project folder itself", style = MaterialTheme.typography.bodySmall)
                }
                Switch(
                    checked = worktree,
                    onCheckedChange = { worktree = it },
                    colors = SwitchDefaults.colors(checkedTrackColor = Palette.Accent, checkedThumbColor = Palette.Bg, uncheckedTrackColor = Palette.SurfaceHigh, uncheckedBorderColor = Palette.BorderStrong),
                )
            }
            Spacer(Modifier.height(18.dp))
            PrimaryButton(
                if (shell) "Open a shell" else "Hire",
                { hire(queue = false) },
                Modifier.fillMaxWidth(),
                enabled = link.phase == Phase.Connected,
                icon = if (shell) OfficeIcons.Shell else OfficeIcons.Sparkle,
            )
            AnimatedVisibility(!shell && prompt.isNotBlank()) {
                SecondaryButton("Add to the queue instead", { hire(queue = true) }, Modifier.fillMaxWidth().padding(top = 10.dp), enabled = link.phase == Phase.Connected, icon = OfficeIcons.Queue)
            }
            if (link.phase != Phase.Connected) {
                Text("Waiting for the office…", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp).align(Alignment.CenterHorizontally))
            }
        }
    }
}

@Composable
private fun KindCard(icon: ImageVector, title: String, sub: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(12.dp)
    Column(
        modifier.clip(shape).background(if (selected) Palette.AccentMuted else Palette.SurfaceRaised)
            .border(1.dp, if (selected) Palette.Accent else Palette.Border, shape)
            .clickable(onClick = onClick).padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, Modifier.size(22.dp), tint = if (selected) Palette.Accent else Palette.TextSecondary)
            Spacer(Modifier.weight(1f))
            if (selected) Icon(Icons.Default.Check, null, Modifier.size(16.dp), tint = Palette.Accent)
        }
        Spacer(Modifier.height(10.dp))
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(sub, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun ModelPicker(catalogue: ModelCatalogue?, loading: Boolean, selected: String?, onPick: (ModelOption) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val current = catalogue?.models?.firstOrNull { it.id == selected }
    Box {
        Row(
            Modifier.fillMaxWidth().panel(RoundedCornerShape(10.dp), Palette.SurfaceRaised, Palette.BorderStrong)
                .clickable(enabled = catalogue != null) { open = true }.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (loading) {
                Spinner(Modifier.size(14.dp))
                Spacer(Modifier.width(10.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(
                    current?.displayName?.ifBlank { null } ?: current?.id?.let(Workers::shortModel) ?: if (loading) "Loading models…" else "The office's default",
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (current != null) Text(current.id, style = LocalOfficeType.current.eyebrow, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Icon(Icons.Default.KeyboardArrowDown, null, tint = Palette.TextSecondary)
        }
        DropdownMenu(open, onDismissRequest = { open = false }, containerColor = Palette.SurfaceHover, modifier = Modifier.heightIn(max = 380.dp)) {
            catalogue?.models.orEmpty().filterNot { it.legacy && it.id != selected }.forEach { m ->
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(m.displayName.ifBlank { Workers.shortModel(m.id) }, style = MaterialTheme.typography.bodyMedium)
                            Text(if (m.custom) "custom · ${m.id}" else m.id, style = LocalOfficeType.current.eyebrow, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    },
                    trailingIcon = { if (m.id == selected) Icon(Icons.Default.Check, null, tint = Palette.Accent) },
                    onClick = {
                        open = false
                        onPick(m)
                    },
                )
            }
        }
    }
}
