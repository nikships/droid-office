package ai.factory.droidoffice.ui.onboarding

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ai.factory.droidoffice.core.PairingInvite
import ai.factory.droidoffice.core.RouteKind
import ai.factory.droidoffice.core.Routes
import ai.factory.droidoffice.session.PairOutcome
import ai.factory.droidoffice.session.PairStep
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.GlyphMark
import ai.factory.droidoffice.ui.components.PrimaryButton
import ai.factory.droidoffice.ui.components.RouteBadge
import ai.factory.droidoffice.ui.components.SecondaryButton
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.dotGrid
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.Palette

private sealed interface PairUi {
    data class Running(val step: PairStep, val detail: String?) : PairUi
    data class Paired(val outcome: PairOutcome.Paired) : PairUi
    data class Failed(val outcome: PairOutcome.Failed) : PairUi
}

@Composable
fun PairScreen(invite: PairingInvite, onDone: () -> Unit, onRescan: () -> Unit, onCancel: () -> Unit) {
    val graph = LocalGraph.current
    val haptics = LocalHapticFeedback.current
    var attempt by remember { mutableIntStateOf(0) }
    var ui by remember { mutableStateOf<PairUi>(PairUi.Running(PairStep.Reaching, null)) }

    LaunchedEffect(invite, attempt) {
        ui = PairUi.Running(PairStep.Reaching, null)
        val outcome = graph.pairer.pair(invite) { step, detail -> ui = PairUi.Running(step, detail) }
        ui = when (outcome) {
            is PairOutcome.Paired -> PairUi.Paired(outcome).also { haptics.performHapticFeedback(HapticFeedbackType.Confirm) }
            is PairOutcome.Failed -> PairUi.Failed(outcome).also { haptics.performHapticFeedback(HapticFeedbackType.Reject) }
        }
    }

    Box(Modifier.fillMaxSize().background(Palette.Bg).dotGrid()) {
        Column(
            Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(24.dp))
            AnimatedContent(ui is PairUi.Paired, transitionSpec = { fadeIn(tween(300)) togetherWith fadeOut(tween(200)) }, label = "mark") { paired ->
                if (paired) SuccessMark() else GlyphMark(size = 64.dp, glow = ui !is PairUi.Failed)
            }
            Column(Modifier.widthIn(max = 520.dp).fillMaxWidth()) {
                Eyebrow("Pairing", color = Palette.Accent)
                Spacer(Modifier.height(6.dp))
                Text(invite.name, style = MaterialTheme.typography.headlineLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(4.dp))
                Text(
                    "${invite.bases.size} address${if (invite.bases.size == 1) "" else "es"} to try. Wi-Fi wins when it answers; Tailscale is the way in from anywhere else.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(16.dp))
                Column(Modifier.fillMaxWidth().panel().padding(vertical = 4.dp)) {
                    invite.bases.forEach { base -> AddressRow(base) }
                }
                Spacer(Modifier.height(20.dp))
                when (val s = ui) {
                    is PairUi.Running -> Steps(s.step, s.detail)
                    is PairUi.Paired -> {
                        Text("Paired", style = MaterialTheme.typography.headlineSmall, color = Palette.Success)
                        Spacer(Modifier.height(4.dp))
                        Text(
                            if (s.outcome.office.auth == ai.factory.droidoffice.data.AuthMode.Device) {
                                "This phone has its own key for ${s.outcome.office.name}. It keeps working after the office restarts, until you unpair it."
                            } else {
                                "This office is older than phone pairing, so the app uses the code itself. When the office restarts, scan its new code."
                            },
                            style = MaterialTheme.typography.bodyMedium,
                            color = Palette.TextSecondary,
                        )
                        Spacer(Modifier.height(10.dp))
                        RouteBadge(s.outcome.kind, connected = true)
                    }
                    is PairUi.Failed -> {
                        Text(s.outcome.title, style = MaterialTheme.typography.headlineSmall, color = Palette.Danger)
                        Spacer(Modifier.height(4.dp))
                        Text(s.outcome.message, style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary)
                    }
                }
            }
            Spacer(Modifier.weight(1f).height(28.dp))
            Column(Modifier.widthIn(max = 520.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                when (ui) {
                    is PairUi.Paired -> PrimaryButton("Open the office", onDone, Modifier.fillMaxWidth())
                    is PairUi.Failed -> {
                        PrimaryButton("Try again", { attempt++ }, Modifier.fillMaxWidth())
                        SecondaryButton("Scan another code", onRescan, Modifier.fillMaxWidth())
                    }
                    is PairUi.Running -> TextButton(onClick = onCancel, modifier = Modifier.fillMaxWidth().height(48.dp)) {
                        Text("Cancel", color = Palette.TextSecondary)
                    }
                }
            }
        }
    }
}

@Composable
private fun AddressRow(base: String) {
    val kind = Routes.kindOf(base)
    Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(base.substringAfter("://"), style = LocalOfficeType.current.monoBody, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(
            when (kind) {
                RouteKind.Lan -> "WI-FI"
                RouteKind.Tailscale -> "TAILSCALE"
                RouteKind.Remote -> "INTERNET"
            },
            style = LocalOfficeType.current.eyebrow,
        )
    }
}

@Composable
private fun Steps(step: PairStep, detail: String?) {
    val steps = listOf(
        PairStep.Reaching to "Finding the office",
        PairStep.Pairing to "Getting this phone a key",
        PairStep.Saving to "Saving it on this phone",
    )
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        steps.forEach { (s, label) ->
            val state = when {
                s.ordinal < step.ordinal -> 2
                s == step -> 1
                else -> 0
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(22.dp), contentAlignment = Alignment.Center) {
                    when (state) {
                        2 -> Box(Modifier.size(20.dp).background(Palette.Success.copy(alpha = 0.16f), CircleShape), contentAlignment = Alignment.Center) {
                            Icon(Icons.Default.Check, null, Modifier.size(14.dp), tint = Palette.Success)
                        }
                        1 -> Spinner(Modifier.size(18.dp))
                        else -> Box(Modifier.size(7.dp).background(Palette.BorderStrong, CircleShape))
                    }
                }
                Spacer(Modifier.size(12.dp))
                Column {
                    Text(label, style = MaterialTheme.typography.bodyMedium, color = if (state == 0) Palette.TextTertiary else Palette.Text)
                    if (state == 1 && detail != null) Text(detail, style = LocalOfficeType.current.eyebrow)
                }
            }
        }
    }
}

@Composable
private fun SuccessMark() {
    val pop = remember { Animatable(0.4f) }
    LaunchedEffect(Unit) { pop.animateTo(1f, spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessLow)) }
    Box(Modifier.size(115.dp), contentAlignment = Alignment.Center) {
        Box(
            Modifier.size(84.dp).graphicsLayer { scaleX = pop.value; scaleY = pop.value }
                .background(Palette.Success.copy(alpha = 0.14f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.size(56.dp).background(Palette.Success, CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Default.Check, "Paired", Modifier.size(30.dp), tint = Palette.Bg)
            }
        }
    }
}
