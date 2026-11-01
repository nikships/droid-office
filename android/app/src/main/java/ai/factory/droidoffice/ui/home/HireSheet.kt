package ai.factory.droidoffice.ui.home

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.Availability
import ai.factory.droidoffice.core.Effort
import ai.factory.droidoffice.core.FactoryCloud
import ai.factory.droidoffice.core.ModelAvailability
import ai.factory.droidoffice.core.ModelSearch
import ai.factory.droidoffice.core.RunsOn
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.net.ModelCatalogue
import ai.factory.droidoffice.session.Phase
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.Chip
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.PrimaryButton
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import kotlinx.coroutines.launch

// A task typed and then closed by mistake is still there the next time hiring opens.
private var promptDraft = ""

/**
 * Hire a worker at the next free desk, or at [deskId] when one was picked on the map: a Droid agent
 * with a task (or none yet), or a plain shell. A full screen with its own close button rather than a
 * sheet, so scrolling the form can never drag it away.
 */
@Composable
fun HireSheet(onDismiss: () -> Unit, deskId: String? = null) {
    val graph = LocalGraph.current
    val connection = graph.connection
    val link by connection.link.collectAsStateWithLifecycle()
    val availability by connection.availability.collectAsStateWithLifecycle()
    val data by connection.data.collectAsStateWithLifecycle()
    val factory by connection.factory.collectAsStateWithLifecycle()
    val worktreeOption = data.floor?.home != true && data.floor?.plain != true && !data.project?.branch.isNullOrBlank()
    val places = remember(factory) { FactoryCloud.choices(factory) }

    var shell by rememberSaveable { mutableStateOf(false) }
    var prompt by rememberSaveable { mutableStateOf(promptDraft) }
    var worktree by rememberSaveable { mutableStateOf(true) }
    var modelId by rememberSaveable { mutableStateOf<String?>(null) }
    var effort by rememberSaveable { mutableStateOf<String?>(null) }
    var placeKey by rememberSaveable { mutableStateOf("") }
    var folder by rememberSaveable(placeKey) { mutableStateOf("") }
    var failed by remember { mutableStateOf(false) }
    var catalogue by remember { mutableStateOf<ModelCatalogue?>(null) }
    var loadingModels by remember { mutableStateOf(true) }

    LaunchedEffect(link.phase) {
        if (link.phase != Phase.Connected || catalogue != null) return@LaunchedEffect
        loadingModels = true
        catalogue = connection.models()
        loadingModels = false
        val c = catalogue ?: return@LaunchedEffect
        // Start on what the last Droid was hired with, when this office still offers it.
        val last = graph.store.snapshot.value.settings
        val remembered = last.hireModel?.takeIf(ModelSearch::customId)
        if (modelId == null) modelId = remembered ?: c.defaultModel ?: c.models.firstOrNull { !it.legacy }?.id
        if (effort == null) effort = last.hireEffort.takeIf { remembered != null && modelId == remembered }
            ?: c.models.firstOrNull { it.id == modelId }?.defaultReasoningEffort ?: c.defaultReasoningEffort
    }
    val model = catalogue?.models?.firstOrNull { it.id == modelId }
    val efforts = model?.supportedReasoningEfforts?.mapNotNull(Effort::of).orEmpty()
    // A computer or Environment that went away falls back to this machine.
    val place = places.firstOrNull { it.key == placeKey } ?: RunsOn.ThisMachine
    val cloud = !shell && place != RunsOn.ThisMachine
    val cloudBlocked = cloud && !FactoryCloud.runsInCloud(modelId)
    val pickable = if (!cloud) availability else availability + catalogue?.models.orEmpty().filterNot { FactoryCloud.runsInCloud(it.id) }.associate { it.id to ModelAvailability.NotInCloud }
    val connected = link.phase == Phase.Connected

    fun hire() {
        val kind = if (shell) "shell" else "agent"
        val e = effort?.takeIf { w -> efforts.isEmpty() || efforts.any { it.wire == w } }
        val ok = connection.hire(prompt.trim().takeIf { !shell && it.isNotBlank() }, kind, modelId, e, worktreeOption && worktree && !cloud, deskId, if (cloud) FactoryCloud.hire(place, folder) else null)
        if (ok) {
            if (!shell) promptDraft = ""
            if (!shell && modelId != null) graph.scope.launch { graph.store.settings { it.copy(hireModel = modelId, hireEffort = e) } }
            onDismiss()
        } else {
            failed = true
        }
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Column(Modifier.fillMaxSize().background(Palette.Bg).windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)).tagged(Tags.Hire.SHEET)) {
            Row(Modifier.fillMaxWidth().padding(start = 6.dp, end = 20.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onDismiss, modifier = Modifier.tagged(Tags.Hire.CLOSE)) { Icon(Icons.Default.Close, "Close", tint = Palette.Text) }
                Spacer(Modifier.width(4.dp))
                Column(Modifier.weight(1f)) {
                    Text("Hire a worker", style = MaterialTheme.typography.titleLarge)
                    Text(if (deskId != null) "At ${deskLabel(deskId)}" else "At the next free desk", style = MaterialTheme.typography.bodySmall)
                }
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Border))
            Column(
                Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 18.dp),
                verticalArrangement = Arrangement.spacedBy(22.dp),
            ) {
                KindSwitch(shell) { shell = it }
                AnimatedVisibility(!shell) {
                    Column(verticalArrangement = Arrangement.spacedBy(22.dp)) {
                        Field("Task") {
                            OutlinedTextField(
                                value = prompt,
                                onValueChange = { prompt = it; promptDraft = it },
                                modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp, max = 260.dp).tagged(Tags.Hire.PROMPT),
                                placeholder = { Text("What should it work on?", color = Palette.TextTertiary) },
                                supportingText = { Text("Leave it empty to brief it later.", color = Palette.TextTertiary) },
                                textStyle = MaterialTheme.typography.bodyLarge,
                                shape = RoundedCornerShape(12.dp),
                                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                                colors = fieldColors(),
                            )
                        }
                        Field("Model") {
                            ModelPicker(catalogue, loadingModels && connected, modelId, pickable) { m ->
                                modelId = m.id
                                effort = m.defaultReasoningEffort ?: effort
                            }
                        }
                        if (efforts.isNotEmpty()) Field("Reasoning") {
                            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                efforts.forEach { e -> Chip(e.label, effort == e.wire, { effort = e.wire }, Modifier.tagged(Tags.Hire.effort(e.wire))) }
                            }
                        }
                        if (places.size > 1) Field("Runs on") {
                            RunsOnMenu(places, place) { placeKey = it.key }
                            if (cloudBlocked) Text(
                                "Your own models can't run on a Factory computer. Pick one of Factory's models, or run it on this machine.",
                                style = MaterialTheme.typography.bodySmall,
                                color = Palette.Danger,
                                modifier = Modifier.padding(top = 8.dp).tagged(Tags.Hire.CLOUD_MODEL),
                            )
                        }
                        if (cloud) Field("Folder") {
                            OutlinedTextField(
                                value = folder,
                                onValueChange = { folder = it },
                                modifier = Modifier.fillMaxWidth().tagged(Tags.Hire.FOLDER),
                                supportingText = FactoryCloud.folderPlaceholder(place, data.floor?.repo)?.let { { Text(it, color = Palette.TextSecondary) } },
                                singleLine = true,
                                textStyle = MaterialTheme.typography.bodyLarge,
                                shape = RoundedCornerShape(12.dp),
                                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                                colors = fieldColors(),
                            )
                            FactoryCloud.note(place)?.let {
                                Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.TextTertiary, modifier = Modifier.padding(top = 4.dp, start = 16.dp).tagged(Tags.Hire.FOLDER_NOTE))
                            }
                        }
                    }
                }
                if (worktreeOption && !cloud) WorktreeSwitch(worktree) { worktree = it }
            }
            Column(Modifier.fillMaxWidth().background(Palette.Surface)) {
                Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Border))
                // The bar's surface runs under the navigation bar; the button rides on the keyboard.
                Column(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom)).padding(horizontal = 20.dp, vertical = 14.dp)) {
                    PrimaryButton(
                        if (shell) "Open a shell" else "Hire",
                        { hire() },
                        Modifier.fillMaxWidth().tagged(Tags.Hire.SUBMIT),
                        enabled = connected && (shell || (!Availability.cannotRun(availability[modelId]) && !cloudBlocked)),
                        icon = if (shell) OfficeIcons.Shell else OfficeIcons.Sparkle,
                    )
                    val status = when {
                        !connected -> "Waiting for the office…"
                        failed -> "Not connected to the office yet"
                        else -> null
                    }
                    if (status != null) Text(status, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp).align(Alignment.CenterHorizontally))
                }
            }
        }
    }
}

@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(focusedBorderColor = Palette.Accent, unfocusedBorderColor = Palette.BorderStrong, cursorColor = Palette.Accent)

@Composable
private fun Field(label: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Eyebrow(label)
        Spacer(Modifier.height(8.dp))
        content()
    }
}

/** Droid or Shell, as one segmented control. */
@Composable
private fun KindSwitch(shell: Boolean, onShell: (Boolean) -> Unit) {
    Column {
        val shape = RoundedCornerShape(12.dp)
        Row(Modifier.fillMaxWidth().panel(shape, Palette.Surface).padding(4.dp).selectableGroup(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Segment(OfficeIcons.Agent, "Droid", !shell, Modifier.weight(1f).tagged(Tags.Hire.DROID)) { onShell(false) }
            Segment(OfficeIcons.Shell, "Shell", shell, Modifier.weight(1f).tagged(Tags.Hire.SHELL)) { onShell(true) }
        }
        Text(
            if (shell) "A plain terminal at a desk, with no agent in it." else "An agent that takes a task and works on it.",
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(start = 4.dp, top = 8.dp),
        )
    }
}

@Composable
private fun Segment(icon: ImageVector, label: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(9.dp)
    Row(
        modifier.clip(shape).background(if (selected) Palette.AccentMuted else Palette.Surface)
            .border(1.dp, if (selected) Palette.Accent else Palette.Surface, shape)
            .selectable(selected, role = Role.RadioButton, onClick = onClick).heightIn(min = 44.dp).padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Icon(icon, null, Modifier.size(18.dp), tint = if (selected) Palette.Accent else Palette.TextSecondary)
        Spacer(Modifier.width(8.dp))
        Text(label, style = MaterialTheme.typography.titleSmall, color = if (selected) Palette.Text else Palette.TextSecondary)
    }
}

@Composable
private fun WorktreeSwitch(on: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().panel(RoundedCornerShape(12.dp), Palette.SurfaceRaised).toggleable(on, role = Role.Switch, onValueChange = onChange).tagged(Tags.Hire.WORKTREE).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(OfficeIcons.Branch, null, Modifier.size(18.dp), tint = Palette.TextSecondary)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text("Its own worktree", style = MaterialTheme.typography.titleSmall)
            Text(if (on) "A fresh branch, so its changes never touch yours" else "Works in the project folder itself", style = MaterialTheme.typography.bodySmall)
        }
        Spacer(Modifier.width(12.dp))
        Switch(
            checked = on,
            onCheckedChange = null,
            colors = SwitchDefaults.colors(checkedTrackColor = Palette.Accent, checkedThumbColor = Palette.Bg, uncheckedTrackColor = Palette.SurfaceHigh, uncheckedBorderColor = Palette.BorderStrong),
        )
    }
}

private fun RunsOn.icon(): ImageVector = when (this) {
    RunsOn.ThisMachine -> OfficeIcons.Laptop
    is RunsOn.Environment -> OfficeIcons.Layers
    is RunsOn.Computer -> OfficeIcons.Cloud
}

/**
 * Where a Droid runs, as a dropdown: this machine, a fresh computer from one of the account's
 * Environments, or one of its active computers (the web's runsOnPicker).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RunsOnMenu(places: List<RunsOn>, place: RunsOn, onPick: (RunsOn) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(12.dp)
    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }) {
        Row(
            Modifier.fillMaxWidth().menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable)
                .panel(shape, Palette.SurfaceRaised, if (open) Palette.Accent else Palette.BorderStrong)
                .tagged(Tags.Hire.RUNS_ON).heightIn(min = 56.dp).padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(place.icon(), null, Modifier.size(20.dp), tint = Palette.TextSecondary)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(place.title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(place.detail, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Icon(Icons.Default.KeyboardArrowDown, null, Modifier.rotate(if (open) 180f else 0f), tint = Palette.TextSecondary)
        }
        ExposedDropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            shape = shape,
            containerColor = Palette.SurfaceRaised,
            border = BorderStroke(1.dp, Palette.BorderStrong),
        ) {
            var group: String? = null
            places.forEach { p ->
                val heading = when (p) {
                    RunsOn.ThisMachine -> null
                    is RunsOn.Environment -> "A fresh computer"
                    is RunsOn.Computer -> "Your computers"
                }
                if (heading != null && heading != group) {
                    group = heading
                    Eyebrow(heading, Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp), color = Palette.TextTertiary)
                }
                val on = p == place
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(p.title, style = MaterialTheme.typography.bodyLarge, color = if (on) Palette.Text else Palette.TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(p.detail, style = MaterialTheme.typography.bodySmall, color = Palette.TextTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    },
                    onClick = { onPick(p); open = false },
                    leadingIcon = { Icon(p.icon(), null, Modifier.size(20.dp), tint = if (on) Palette.Accent else Palette.TextSecondary) },
                    trailingIcon = if (on) ({ Icon(Icons.Default.Check, null, Modifier.size(18.dp), tint = Palette.Accent) }) else null,
                    modifier = Modifier.semantics { selected = on }.tagged(Tags.Hire.runsOn(p.key)),
                )
            }
        }
    }
}
