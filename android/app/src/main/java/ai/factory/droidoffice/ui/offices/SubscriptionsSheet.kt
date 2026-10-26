package ai.factory.droidoffice.ui.offices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.ModelBrand
import ai.factory.droidoffice.core.Subscriptions
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.BrandLogo
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.home.rememberNow
import ai.factory.droidoffice.ui.theme.Palette

/** The paired office's real plans. Installation and sign-in stay on its Mac, not this phone. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SubscriptionsSheet(onDismiss: () -> Unit) {
    val state by LocalGraph.current.connection.subscriptions.collectAsStateWithLifecycle()
    val now = rememberNow(30_000)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Palette.Surface) {
        Column(Modifier.fillMaxWidth().tagged(Tags.Subscriptions.SHEET).verticalScroll(rememberScrollState()).navigationBarsPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Subscriptions", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
                TextButton(onClick = onDismiss, modifier = Modifier.tagged(Tags.Subscriptions.CLOSE)) { Text("Done") }
            }
            Text("The plans your office's workers run on. Manage sign-ins, accounts and DroidProxy in the office's Settings → Subscriptions on its Mac.", style = MaterialTheme.typography.bodyMedium)
            val s = state
            if (s == null) {
                Text("No subscription status yet. Connect to the office; older offices may need an update.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.tagged(Tags.Subscriptions.STATUS))
            } else {
                Column(Modifier.fillMaxWidth().panel().padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Eyebrow("DroidProxy")
                    Text(Subscriptions.proxy(s.proxy), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.tagged(Tags.Subscriptions.STATUS))
                    s.proxy.error?.let { Text(it, color = Palette.Warning, style = MaterialTheme.typography.bodySmall) }
                    s.models?.let { Text("${it.installed} models in Droid · ${it.available} available${if (it.stale) " · update the model list on the Mac" else ""}", style = MaterialTheme.typography.bodySmall) }
                }
                if (s.providers.isEmpty() && s.proxy.phase != "unsupported") Text("No accounts are listed yet. Connect a plan on the office's Mac.", style = MaterialTheme.typography.bodyMedium)
                s.providers.forEach { provider ->
                    Column(Modifier.fillMaxWidth().panel().padding(14.dp).tagged(Tags.Subscriptions.provider(provider.key)), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            BrandLogo(ModelBrand.provider(provider.key), Modifier.size(28.dp))
                            Column {
                                Text(Subscriptions.provider(provider.key), style = MaterialTheme.typography.titleMedium)
                                Text(if (!provider.enabled) "Switched off · its models can't run" else if (provider.accounts.isEmpty()) "Not connected" else "${provider.accounts.size} account${if (provider.accounts.size == 1) "" else "s"}", style = MaterialTheme.typography.bodySmall)
                            }
                        }
                        provider.accounts.forEach { account ->
                            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(account.label, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                if (account.expired || account.disabled) Text(if (account.expired) "Sign-in expired" else "Off in DroidProxy", color = Palette.Warning, style = MaterialTheme.typography.bodySmall)
                                account.windows.forEach { window ->
                                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                        Text(window.name, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                                        Text(window.words(now), style = MaterialTheme.typography.bodySmall)
                                    }
                                    LinearProgressIndicator(progress = { window.left / 100f }, modifier = Modifier.fillMaxWidth(), color = if (window.left == 0) Palette.Danger else if (window.left < 20) Palette.Warning else Palette.Success, trackColor = Palette.SurfaceHigh)
                                }
                                account.usageError?.let { Text("Usage unavailable: $it", style = MaterialTheme.typography.bodySmall) }
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}
