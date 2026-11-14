package ai.factory.droidoffice.ui.offices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.FactoryLimits
import ai.factory.droidoffice.core.SubscriptionProvider
import ai.factory.droidoffice.core.Subscriptions
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.Palette
import kotlinx.coroutines.launch

/** Factory does not depend on DroidProxy being supported or installed on the office's machine. */
@Composable
internal fun FactorySubscriptions(now: Long) {
    val connection = LocalGraph.current.connection
    val factory by connection.factory.collectAsStateWithLifecycle()
    val data by connection.data.collectAsStateWithLifecycle()
    val link by connection.link.collectAsStateWithLifecycle()
    val officeId = remember { data.officeId }
    val scope = rememberCoroutineScope()
    var confirm by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var result by remember { mutableStateOf<String?>(null) }
    var pickedTier by remember { mutableStateOf<String?>(null) }
    val s = factory ?: return
    val l = s.limits
    if (!FactoryLimits.connected(s)) return
    val active = FactoryLimits.active(l)
    Column(Modifier.fillMaxWidth().panel().padding(14.dp).tagged(Tags.Subscriptions.FACTORY), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Eyebrow("Factory limits & overage")
        if (!active) {
            Text(
                when {
                    l.error != null -> "Factory limits could not be read"
                    l.usesTokenRateLimitsBilling == false || l.fetchedAt != null -> "Token rate-limit windows do not apply to this Factory account"
                    else -> "Waiting for Factory limits…"
                },
                style = MaterialTheme.typography.bodyMedium, modifier = Modifier.tagged(Tags.Subscriptions.FACTORY_STATUS),
            )
        } else {
            if (l.hasActiveSubscription == false) Text("Factory subscription is inactive", color = Palette.Warning, modifier = Modifier.tagged(Tags.Subscriptions.FACTORY_STATUS))
            listOf("standard" to l.limits.standard, "core" to l.limits.core).forEach { (tier, windows) ->
                if (windows != null) {
                    val account = FactoryLimits.account(tier, windows, l.fetchedAt)
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
                        QuotaRing(SubscriptionProvider(key = "factory", name = "Factory"), account, pickedTier == tier) { pickedTier = if (pickedTier == tier) null else tier }
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("Factory ${account.label}", style = MaterialTheme.typography.titleSmall)
                            windows.named().zip(account.windows).forEach { (raw, window) ->
                                Column(Modifier.tagged(Tags.Subscriptions.factoryWindow(tier, raw.first))) {
                                    Text(window.line, style = MaterialTheme.typography.bodyMedium)
                                    Text(
                                        window.reset(now) ?: if (raw.second.windowEnd == null && raw.second.secondsRemaining == null && raw.second.usedPercent == 0.0) "Window has not started" else "Awaiting updated reset time",
                                        style = MaterialTheme.typography.bodySmall, color = Palette.TextSecondary,
                                    )
                                }
                            }
                        }
                    }
                }
            }
            Text("Extra Usage balance: ${FactoryLimits.balance(l)}${if (!l.extraUsageAllowed) " · Not allowed" else ""}", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.tagged(Tags.Subscriptions.FACTORY_BALANCE))
            Text("Overage preference: ${FactoryLimits.mode(l)}", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.tagged(Tags.Subscriptions.FACTORY_MODE))
            if (l.canManageOverage) {
                val enabled = !busy && l.error == null && connection.connected && data.officeId == officeId && link.phase == ai.factory.droidoffice.session.Phase.Connected
                listOf("droidCore" to "Droid Core", "extraUsage" to "Extra Usage").forEach { (mode, label) ->
                    Row(
                        Modifier.fillMaxWidth().selectable(l.overagePreference == mode, enabled = enabled, role = Role.RadioButton) {
                            if (l.overagePreference != mode) confirm = mode
                        }.tagged(Tags.Subscriptions.overage(mode)).padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        RadioButton(selected = l.overagePreference == mode, onClick = null, enabled = enabled)
                        Text(label, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            } else Text("Only a Factory billing administrator can change the overage preference", style = MaterialTheme.typography.bodySmall, color = Palette.TextSecondary)
        }
        l.error?.let { Text(it, color = Palette.Warning, modifier = Modifier.tagged(Tags.Subscriptions.FACTORY_ERROR)) }
        error?.let { Text(it, color = Palette.Warning, modifier = Modifier.tagged(Tags.Subscriptions.FACTORY_RESULT)) }
        if (error == null) result?.let { Text(it, color = Palette.TextSecondary, modifier = Modifier.tagged(Tags.Subscriptions.FACTORY_RESULT)) }
        if (busy) Text("Saving overage preference…", style = MaterialTheme.typography.bodySmall)
    }
    confirm?.let { preference ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            modifier = Modifier.tagged(Tags.Subscriptions.OVERAGE_CONFIRM),
            containerColor = Palette.SurfaceRaised,
            title = { Text("Change Factory overage preference?") },
            text = { Text(if (preference == "extraUsage") "After Standard quota runs out, Factory can use your paid Extra Usage balance. This changes the preference for your Factory organization." else "After Standard quota runs out, switch to available Droid Core models instead of spending Extra Usage. This changes the preference for your Factory organization.") },
            confirmButton = {
                TextButton(onClick = {
                    confirm = null
                    busy = true
                    error = null
                    result = null
                    scope.launch {
                        val saved = officeId?.let { connection.factoryOverage(it, preference) }
                        busy = false
                        if (saved?.isSuccess == true) result = "Overage preference saved. Waiting for refreshed Factory limits."
                        else error = saved?.exceptionOrNull()?.message ?: "Not connected to the office"
                    }
                }, modifier = Modifier.tagged(Tags.Subscriptions.OVERAGE_SAVE)) { Text("Change preference") }
            },
            dismissButton = { TextButton(onClick = { confirm = null }, modifier = Modifier.tagged(Tags.Subscriptions.OVERAGE_CANCEL)) { Text("Cancel") } },
        )
    }
}
