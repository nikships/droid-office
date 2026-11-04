package ai.factory.droidoffice.ui.offices

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.ModelBrand
import ai.factory.droidoffice.core.SubscriptionAccount
import ai.factory.droidoffice.core.SubscriptionProvider
import ai.factory.droidoffice.core.Subscriptions
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.BrandLogo
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.home.rememberNow
import ai.factory.droidoffice.ui.theme.Palette

/** The paired office's real plans as quota rings, like the web companion. Installation and sign-in stay on its Mac, not this phone. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SubscriptionsSheet(onDismiss: () -> Unit) {
    val state by LocalGraph.current.connection.subscriptions.collectAsStateWithLifecycle()
    val now = rememberNow(30_000)
    var picked by rememberSaveable { mutableStateOf<String?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Palette.Surface) {
        Column(Modifier.fillMaxWidth().tagged(Tags.Subscriptions.SHEET).verticalScroll(rememberScrollState()).navigationBarsPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Subscriptions", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
                TextButton(onClick = onDismiss, modifier = Modifier.tagged(Tags.Subscriptions.CLOSE)) { Text("Done") }
            }
            val s = state
            if (s == null) {
                Text("No subscription status yet. Connect to the office; older offices may need an update.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.tagged(Tags.Subscriptions.STATUS))
            } else {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val dot = when (s.proxy.phase) {
                        "running" -> Palette.Success
                        "unsupported", "missing" -> Palette.TextTertiary
                        else -> Palette.Warning
                    }
                    Box(Modifier.size(6.dp).background(dot, CircleShape))
                    Text(Subscriptions.proxyLine(s), style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary, modifier = Modifier.tagged(Tags.Subscriptions.STATUS))
                }
                s.proxy.error?.let { Text(it, color = Palette.Warning, style = MaterialTheme.typography.bodySmall) }
                val groups = Subscriptions.groups(s.providers)
                if (groups.active.isEmpty() && s.proxy.phase != "unsupported") Text("No plans in use. Connect one on the office's Mac.", style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(28.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                    groups.active.forEach { provider ->
                        Column(Modifier.tagged(Tags.Subscriptions.provider(provider.key)), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Eyebrow(Subscriptions.provider(provider.key))
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                provider.accounts.forEach { account ->
                                    val key = "${provider.key}/${account.id}"
                                    QuotaRing(provider, account, picked == key) { picked = if (picked == key) null else key }
                                }
                            }
                        }
                    }
                }
                groups.active.firstNotNullOfOrNull { p -> p.accounts.firstOrNull { "${p.key}/${it.id}" == picked }?.let { p to it } }?.let { (provider, account) ->
                    Column(Modifier.fillMaxWidth().panel().padding(14.dp).tagged(Tags.Subscriptions.DETAIL), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("${Subscriptions.provider(provider.key)} · ${account.label}", style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Subscriptions.state(account)?.let { Text(it, color = Palette.Warning, style = MaterialTheme.typography.bodySmall) }
                        account.windows.forEach { window ->
                            Column {
                                Text(window.line, style = MaterialTheme.typography.bodyMedium)
                                window.reset(now)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.TextSecondary) }
                            }
                        }
                        Subscriptions.missing(account)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.TextSecondary) }
                    }
                }
                ProviderLine("Off", groups.off, Tags.Subscriptions.OFF)
                ProviderLine("Not connected", groups.unconnected, Tags.Subscriptions.UNCONNECTED)
                if (s.proxy.phase != "unsupported") Text("Manage accounts in Settings → Connections on the office's Mac", style = MaterialTheme.typography.bodySmall, color = Palette.TextTertiary)
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

/** An account's ring: one arc per usage window, outermost first, the provider's logo inside. Tapping it shows the windows and resets underneath. */
@Composable
private fun QuotaRing(provider: SubscriptionProvider, account: SubscriptionAccount, picked: Boolean, onClick: () -> Unit) {
    val muted = Subscriptions.state(account) != null || account.windows.isEmpty()
    val windows = account.windows.take(3)
    Column(
        Modifier.width(80.dp)
            .selectable(picked, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = Subscriptions.ringLabel(provider, account) }
            .tagged(Tags.Subscriptions.ring(provider.key, account.id))
            .padding(vertical = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            Modifier.size(56.dp).alpha(if (muted) 0.45f else 1f).drawBehind {
                val stroke = 4.dp.toPx()
                val step = 6.dp.toPx()
                val track = Color.White.copy(alpha = 0.08f)
                (if (windows.isEmpty()) listOf(null) else windows).forEachIndexed { i, w ->
                    val inset = i * step + stroke / 2
                    val topLeft = Offset(inset, inset)
                    val arc = Size(size.width - inset * 2, size.height - inset * 2)
                    drawArc(if (w != null && w.left == 0) Palette.Danger.copy(alpha = 0.3f) else track, 0f, 360f, false, topLeft, arc, style = Stroke(stroke))
                    if (w != null && w.left > 0) {
                        val tone = if (w.left < 20) Palette.Warning else Palette.Success
                        drawArc(tone, -90f, 360f * w.left / 100f, false, topLeft, arc, style = Stroke(stroke, cap = StrokeCap.Round))
                    }
                }
                if (picked) drawCircle(Palette.BorderStrong, radius = size.minDimension / 2 + 3.dp.toPx(), style = Stroke(1.dp.toPx()))
            },
            contentAlignment = Alignment.Center,
        ) { BrandLogo(ModelBrand.provider(provider.key), Modifier.size(18.dp)) }
        Text(account.label, style = MaterialTheme.typography.bodySmall, color = Palette.TextTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.clearAndSetSemantics {})
    }
}

/** A muted line of providers ("Off", "Not connected") with their logos; nothing when there are none. */
@Composable
private fun ProviderLine(label: String, providers: List<SubscriptionProvider>, tag: String) {
    if (providers.isEmpty()) return
    FlowRow(Modifier.fillMaxWidth().tagged(tag), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp), itemVerticalAlignment = Alignment.CenterVertically) {
        Eyebrow(label, color = Palette.TextTertiary)
        providers.forEach { p ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                BrandLogo(ModelBrand.provider(p.key), Modifier.size(14.dp).alpha(0.5f), monoTint = Palette.TextTertiary)
                Text(Subscriptions.provider(p.key), style = MaterialTheme.typography.bodySmall, color = Palette.TextTertiary)
            }
        }
    }
}
