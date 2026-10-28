package ai.factory.droidoffice

import ai.factory.droidoffice.core.InviteParse
import ai.factory.droidoffice.core.Pairing
import ai.factory.droidoffice.core.PairingInvite
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.LocalOpenUpdates
import ai.factory.droidoffice.ui.components.UpdateDialog
import ai.factory.droidoffice.ui.offices.OfficesScreen
import ai.factory.droidoffice.ui.onboarding.PairScreen
import ai.factory.droidoffice.ui.onboarding.ScanScreen
import ai.factory.droidoffice.ui.onboarding.WelcomeScreen
import ai.factory.droidoffice.ui.theme.DroidOfficeTheme
import ai.factory.droidoffice.ui.theme.Palette
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.ui.NavDisplay
import kotlinx.serialization.Serializable

@Serializable private data object WelcomeKey : NavKey
@Serializable private data object ScanKey : NavKey
@Serializable private data class PairKey(val invite: PairingInvite) : NavKey
@Serializable private data object OfficesKey : NavKey

/**
 * The device's own screens, over the React Native workspace: pairing (the welcome, the QR scanner, a
 * pairing link), and this phone's offices and settings. Finishing returns to the workspace.
 */
class SetupActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val graph = graph
        val link = intent.getStringExtra(EXTRA_LINK)?.take(4096)
        val start: NavKey = when {
            link != null -> when (val r = Pairing.parse(link)) {
                is InviteParse.Ok -> PairKey(r.invite)
                is InviteParse.Invalid -> {
                    Toast.makeText(this, r.reason, Toast.LENGTH_LONG).show()
                    finish()
                    return
                }
            }
            intent.getStringExtra(EXTRA_SCREEN) == PAIR -> if (graph.store.snapshot.value.offices.isEmpty()) WelcomeKey else ScanKey
            else -> OfficesKey
        }
        setContent {
            DroidOfficeTheme {
                val store by graph.store.snapshot.collectAsStateWithLifecycle()
                val stack = rememberNavBackStack(start)
                var showUpdate by rememberSaveable { mutableStateOf(false) }
                val systemHaptics = LocalHapticFeedback.current
                val haptics = remember(store.settings.haptics, systemHaptics) {
                    if (store.settings.haptics) systemHaptics else object : HapticFeedback {
                        override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) = Unit
                    }
                }
                fun pop() {
                    if (stack.size > 1) stack.removeAt(stack.lastIndex) else finish()
                }
                fun push(key: NavKey) {
                    if (stack.lastOrNull() != key) stack.add(key)
                }
                CompositionLocalProvider(LocalGraph provides graph, LocalHapticFeedback provides haptics, LocalOpenUpdates provides { showUpdate = true }) {
                    Box(Modifier.fillMaxSize().background(Palette.Bg)) {
                        NavDisplay(
                            backStack = stack,
                            onBack = { pop() },
                            entryProvider = entryProvider {
                                entry<WelcomeKey> { WelcomeScreen(onScan = { push(ScanKey) }, onLink = { push(PairKey(it)) }) }
                                entry<ScanKey> { ScanScreen(onBack = { pop() }, onInvite = { push(PairKey(it)) }) }
                                entry<PairKey> { key ->
                                    PairScreen(
                                        invite = key.invite,
                                        onDone = { finish() },
                                        onRescan = {
                                            pop()
                                            if (stack.lastOrNull() != ScanKey) push(ScanKey)
                                        },
                                        onCancel = { pop() },
                                    )
                                }
                                entry<OfficesKey> { OfficesScreen(onBack = { finish() }, onPairNew = { push(ScanKey) }, onSwitched = { finish() }) }
                            },
                        )
                        if (showUpdate) UpdateDialog(onDismiss = { showUpdate = false })
                    }
                }
            }
        }
    }

    companion object {
        const val EXTRA_SCREEN = "screen"
        const val EXTRA_LINK = "link"
        const val PAIR = "pair"
        const val OFFICES = "offices"
        const val SETTINGS = "settings"

        fun pair(from: android.content.Context, link: String) =
            Intent(from, SetupActivity::class.java).putExtra(EXTRA_LINK, link)
    }
}
