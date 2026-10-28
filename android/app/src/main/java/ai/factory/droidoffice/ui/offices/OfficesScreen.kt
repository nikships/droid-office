package ai.factory.droidoffice.ui.offices

import androidx.compose.foundation.layout.only

import androidx.compose.foundation.layout.WindowInsetsSides

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.BuildConfig
import ai.factory.droidoffice.core.Routes
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.data.AppSettings
import ai.factory.droidoffice.data.AuthMode
import ai.factory.droidoffice.data.LOCAL_OFFICE_LABEL_MAX
import ai.factory.droidoffice.data.PairedOffice
import ai.factory.droidoffice.data.displayName
import ai.factory.droidoffice.data.localOfficeLabel
import ai.factory.droidoffice.session.Phase
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.RouteBadge
import ai.factory.droidoffice.ui.components.SecondaryButton
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.rememberNotifyPermission
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.components.UpdateRow
import ai.factory.droidoffice.ui.home.rememberNow
import ai.factory.droidoffice.core.Workers
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import kotlinx.coroutines.launch

@Composable
fun OfficesScreen(onBack: () -> Unit, onPairNew: () -> Unit, onSwitched: () -> Unit, embedded: Boolean = false) {
    val graph = LocalGraph.current
    val store by graph.store.snapshot.collectAsStateWithLifecycle()
    val link by graph.connection.link.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var forgetting by remember { mutableStateOf<PairedOffice?>(null) }
    var renaming by remember { mutableStateOf<PairedOffice?>(null) }
    var subscriptions by remember { mutableStateOf(false) }
    var hostUpdate by remember { mutableStateOf(false) }
    LaunchedEffect(store.active?.id) { hostUpdate = false }
    val notify = rememberNotifyPermission()
    val canNotify = notify.granted
    val now = rememberNow(30_000)
    if (subscriptions) SubscriptionsSheet { subscriptions = false }
    if (hostUpdate) store.active?.let { office ->
        key(office.id) { HostUpdateSheet(office.id) { hostUpdate = false } }
    }

    fun settings(change: (AppSettings) -> AppSettings) {
        scope.launch { graph.store.settings(change) }
    }

    fun askToNotify() = notify.ask()

    // As the Me tab it sits above the tab bar, which takes the bottom inset.
    val insets = if (embedded) WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal) else WindowInsets.safeDrawing
    Column(Modifier.fillMaxSize().tagged(if (embedded) Tags.Screen.ME else Tags.Screen.OFFICES).background(Palette.Bg).windowInsetsPadding(insets)) {
        if (embedded) {
            Text("Me", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.padding(start = 16.dp, top = 14.dp, bottom = 4.dp))
        } else {
            Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack, modifier = Modifier.tagged(Tags.Offices.BACK)) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                Text("Offices", style = MaterialTheme.typography.headlineSmall)
            }
        }
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 640.dp).fillMaxWidth()) {
                Eyebrow("Paired with this phone", Modifier.padding(start = 4.dp, top = 8.dp, bottom = 8.dp))
                Column(Modifier.fillMaxWidth().panel()) {
                    store.offices.sortedByDescending { it.lastSeenAt }.forEachIndexed { i, o ->
                        if (i > 0) HorizontalDivider(color = Palette.Border)
                        val active = o.id == store.active?.id
                        OfficeRow(
                            o, active, if (active) link.phase == Phase.Connected else null, if (active) link.kind else null, now,
                            onPick = {
                                scope.launch {
                                    graph.store.setActive(o.id)
                                    onSwitched()
                                }
                            },
                            onRename = { renaming = o },
                            onForget = { forgetting = o },
                        )
                    }
                }
                Spacer(Modifier.height(10.dp))
                SecondaryButton("Pair another office", onPairNew, Modifier.fillMaxWidth().tagged(Tags.Offices.PAIR_NEW), icon = OfficeIcons.Scan)
                Spacer(Modifier.height(10.dp))
                SecondaryButton("Subscriptions", { subscriptions = true }, Modifier.fillMaxWidth().tagged(Tags.Subscriptions.OPEN), enabled = store.active != null, icon = OfficeIcons.Sparkle)

                Eyebrow("Notifications", Modifier.padding(start = 4.dp, top = 26.dp, bottom = 8.dp))
                Column(Modifier.fillMaxWidth().panel()) {
                    if (!canNotify) {
                        Row(
                            Modifier.fillMaxWidth().background(Palette.Warning.copy(alpha = 0.07f)).clickable { askToNotify() }.tagged(Tags.Offices.ALLOW_NOTIFICATIONS).padding(14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(OfficeIcons.Bell, null, Modifier.size(18.dp), tint = Palette.Warning)
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) {
                                Text("Notifications are off", style = MaterialTheme.typography.titleSmall)
                                Text("Allow them to hear when a worker needs you.", style = MaterialTheme.typography.bodySmall)
                            }
                            Text("ALLOW", style = LocalOfficeType.current.eyebrow.copy(color = Palette.Accent))
                        }
                        HorizontalDivider(color = Palette.Border)
                    }
                    Toggle(
                        OfficeIcons.Bolt, "Stay connected",
                        "Keep the connection open in the background, so alerts come even with the app closed. Shows a quiet ongoing notification.",
                        store.settings.stayConnected,
                        Tags.Offices.STAY_CONNECTED,
                    ) { on ->
                        settings { it.copy(stayConnected = on) }
                        if (on && !canNotify) askToNotify()
                    }
                    HorizontalDivider(color = Palette.Border)
                    Toggle(OfficeIcons.Bell, "When a worker needs you", "A question, with its first choices and a reply right in the notification.", store.settings.notifyNeedsInput, Tags.Offices.NOTIFY_NEEDS_INPUT) { on ->
                        settings { it.copy(notifyNeedsInput = on) }
                    }
                    HorizontalDivider(color = Palette.Border)
                    Toggle(OfficeIcons.Sparkle, "When a worker finishes", "Its turn is done and the result is waiting.", store.settings.notifyDone, Tags.Offices.NOTIFY_DONE) { on ->
                        settings { it.copy(notifyDone = on) }
                    }
                }

                Eyebrow("Answers", Modifier.padding(start = 4.dp, top = 26.dp, bottom = 8.dp))
                Column(Modifier.fillMaxWidth().panel()) {
                    Toggle(
                        OfficeIcons.Bell, "Wait before sending",
                        "Answers from Asks wait 3 seconds with Cancel before they go. Keys typed into a terminal can't be taken back.",
                        store.settings.answerDelay,
                        Tags.Offices.ANSWER_DELAY,
                    ) { on -> settings { it.copy(answerDelay = on) } }
                }

                Eyebrow("Feel", Modifier.padding(start = 4.dp, top = 26.dp, bottom = 8.dp))
                Column(Modifier.fillMaxWidth().panel()) {
                    Toggle(OfficeIcons.Keyboard, "Haptics", "A light tap on keys, sends and alerts.", store.settings.haptics, Tags.Offices.HAPTICS) { on ->
                        settings { it.copy(haptics = on) }
                    }
                }

                Eyebrow("About", Modifier.padding(start = 4.dp, top = 26.dp, bottom = 8.dp))
                Column(Modifier.fillMaxWidth().panel().padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    About("This phone", graph.deviceName)
                    About("App", "Droid Office ${BuildConfig.VERSION_NAME}")
                    store.active?.version?.let { About("Office", "droid-office $it") }
                    UpdateRow()
                    SecondaryButton("Host desktop app", { hostUpdate = true }, Modifier.fillMaxWidth().tagged(Tags.HostUpdate.OPEN), enabled = store.active != null)
                    Text(
                        "Geist and Geist Mono by Vercel, and the terminal's symbol font, under the SIL Open Font License.",
                        style = MaterialTheme.typography.bodySmall,
                        color = Palette.TextTertiary,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }
            }
        }
    }

    forgetting?.let { o ->
        AlertDialog(
            onDismissRequest = { forgetting = null },
            modifier = Modifier.tagged(Tags.Offices.FORGET_DIALOG),
            containerColor = Palette.SurfaceRaised,
            shape = RoundedCornerShape(16.dp),
            title = { Text("Forget ${o.displayName}?") },
            text = {
                Text(
                    if (o.auth == AuthMode.Device) "The office takes this phone's key back too (when it can be reached), so it stops working until you pair again."
                    else "This phone stops connecting to it. Scan its code to pair again.",
                    style = MaterialTheme.typography.bodyMedium,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    forgetting = null
                    scope.launch { graph.connection.forget(o) }
                }, modifier = Modifier.tagged(Tags.Offices.FORGET_CONFIRM)) { Text("Forget", color = Palette.Danger) }
            },
            dismissButton = { TextButton(onClick = { forgetting = null }, modifier = Modifier.tagged(Tags.Offices.FORGET_CANCEL)) { Text("Keep", color = Palette.TextSecondary) } },
        )
    }

    renaming?.let { o ->
        RenameDialog(
            o,
            onDismiss = { renaming = null },
            onSave = { typed ->
                renaming = null
                val label = localOfficeLabel(typed, o.name)
                scope.launch { graph.store.update(o.id) { it.copy(label = label) } }
            },
        )
    }
}

@Composable
private fun OfficeRow(o: PairedOffice, active: Boolean, connected: Boolean?, kind: ai.factory.droidoffice.core.RouteKind?, now: Long, onPick: () -> Unit, onRename: () -> Unit, onForget: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClickLabel = "Switch to ${o.displayName}", onClick = onPick).tagged(Tags.Offices.office(o.id)).padding(start = 14.dp, end = 4.dp, top = 12.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier.size(38.dp).clip(RoundedCornerShape(9.dp)).background(if (active) Palette.AccentMuted else Palette.SurfaceRaised)
                .border(1.dp, if (active) Palette.Accent.copy(alpha = 0.5f) else Palette.Border, RoundedCornerShape(9.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(OfficeIcons.Building, null, Modifier.size(19.dp), tint = if (active) Palette.Accent else Palette.TextSecondary)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(o.displayName, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false).tagged(Tags.Offices.name(o.id)))
                if (active) {
                    Spacer(Modifier.width(6.dp))
                    Icon(Icons.Default.Check, "Active", Modifier.size(16.dp), tint = Palette.Accent)
                }
            }
            val routes = o.bases.map { Routes.kindOf(it).label }.distinct().joinToString(" + ")
            val called = o.name.takeIf { it.isNotBlank() && it != o.displayName }
            val seen = when {
                connected == true -> null
                o.lastSeenAt > 0 -> "seen ${Workers.ago(o.lastSeenAt, now)}"
                else -> null
            }
            Text(
                listOfNotNull(called, o.project, routes, if (o.auth == AuthMode.Lan) "code until restart" else null, seen).joinToString(" · ").uppercase(),
                style = LocalOfficeType.current.eyebrow,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (connected != null) RouteBadge(kind, connected)
        TextButton(onClick = onRename, modifier = Modifier.tagged(Tags.Offices.rename(o.id)), contentPadding = PaddingValues(horizontal = 8.dp)) {
            Text("Rename", color = Palette.TextSecondary)
        }
        TextButton(onClick = onForget, modifier = Modifier.tagged(Tags.Offices.forget(o.id)), contentPadding = PaddingValues(horizontal = 8.dp)) {
            Text("Forget", color = Palette.TextSecondary)
        }
    }
}

@Composable
private fun RenameDialog(o: PairedOffice, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var draft by remember(o.id) { mutableStateOf(o.displayName) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(o.id) { focus.requestFocus() }
    fun save() = onSave(draft)
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.tagged(Tags.Offices.RENAME_DIALOG).imePadding(),
        containerColor = Palette.SurfaceRaised,
        shape = RoundedCornerShape(16.dp),
        title = { Text("Rename office") },
        text = {
            Column {
                Text(
                    "Only this phone uses this name. Leave it blank to show ${o.name} again.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it.take(LOCAL_OFFICE_LABEL_MAX) },
                    modifier = Modifier.fillMaxWidth().focusRequester(focus).tagged(Tags.Offices.RENAME_INPUT),
                    placeholder = { Text(o.name, maxLines = 1, overflow = TextOverflow.Ellipsis, color = Palette.TextTertiary) },
                    singleLine = true,
                    shape = RoundedCornerShape(10.dp),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done, autoCorrectEnabled = false),
                    keyboardActions = KeyboardActions(onDone = { save() }),
                    colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Palette.Accent, unfocusedBorderColor = Palette.BorderStrong, cursorColor = Palette.Accent),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = ::save, modifier = Modifier.tagged(Tags.Offices.RENAME_SAVE)) { Text("Save", color = Palette.Accent) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, modifier = Modifier.tagged(Tags.Offices.RENAME_CANCEL)) { Text("Cancel", color = Palette.TextSecondary) }
        },
    )
}

@Composable
private fun Toggle(icon: ImageVector, title: String, sub: String, checked: Boolean, tag: String, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().toggleable(checked, role = Role.Switch, onValueChange = onChange).tagged(tag).padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, Modifier.size(18.dp), tint = Palette.TextSecondary)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            Text(sub, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(Modifier.width(10.dp))
        Switch(
            checked = checked,
            onCheckedChange = null,
            colors = SwitchDefaults.colors(checkedTrackColor = Palette.Accent, checkedThumbColor = Palette.Bg, uncheckedTrackColor = Palette.SurfaceHigh, uncheckedBorderColor = Palette.BorderStrong),
        )
    }
}

@Composable
private fun About(label: String, value: String) {
    Row {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary, modifier = Modifier.width(96.dp))
        Text(value, style = LocalOfficeType.current.monoBody, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
