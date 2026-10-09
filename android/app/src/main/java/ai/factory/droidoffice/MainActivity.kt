package ai.factory.droidoffice

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import ai.factory.droidoffice.core.Pairing
import ai.factory.droidoffice.ui.AppRoot
import ai.factory.droidoffice.ui.Incoming
import ai.factory.droidoffice.ui.theme.DroidOfficeTheme
import kotlinx.coroutines.flow.MutableStateFlow

class MainActivity : ComponentActivity() {
    /** What the latest intent asked for: a pairing link, or a droid to open from a notification. */
    private val incoming = MutableStateFlow<Incoming?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val graph = graph
        splash.setKeepOnScreenCondition { !graph.store.snapshot.value.loaded }
        if (savedInstanceState == null) incoming.value = read(intent)
        setContent {
            DroidOfficeTheme {
                AppRoot(graph, incoming)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        read(intent)?.let { incoming.value = it }
    }

    /**
     * The activity is exported (launcher, pairing links, shares), so nothing an intent carries is
     * trusted: links go through the same parser as a scan, and ids must look like ids.
     */
    private fun read(intent: Intent?): Incoming? {
        intent ?: return null
        return when (intent.action) {
            Intent.ACTION_VIEW -> intent.dataString?.let { Incoming.Link(it.take(4096)) }
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)?.take(4096)?.takeIf { Pairing.parseOrNull(it) != null }?.let { Incoming.Link(it) }
            ACTION_OPEN_WORKER -> {
                val office = intent.getStringExtra(EXTRA_OFFICE)?.takeIf { ID.matches(it) } ?: return null
                val worker = intent.getStringExtra(EXTRA_WORKER)?.takeIf { ID.matches(it) } ?: return null
                Incoming.Worker(office, worker)
            }
            ACTION_OPEN_FLOOR -> {
                val office = intent.getStringExtra(EXTRA_OFFICE)?.takeIf { ID.matches(it) } ?: return null
                val floor = intent.getStringExtra(EXTRA_FLOOR)?.takeIf { ID.matches(it) } ?: return null
                Incoming.Floor(office, floor)
            }
            else -> null
        }
    }

    companion object {
        const val ACTION_OPEN_WORKER = "ai.factory.droidoffice.OPEN_WORKER"
        const val ACTION_OPEN_FLOOR = "ai.factory.droidoffice.OPEN_FLOOR"
        const val EXTRA_OFFICE = "office"
        const val EXTRA_WORKER = "worker"
        const val EXTRA_FLOOR = "floor"
        private val ID = Regex("^[A-Za-z0-9_\\-:.]{1,64}$")
    }
}
