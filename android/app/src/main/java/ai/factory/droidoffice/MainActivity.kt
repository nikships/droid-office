package ai.factory.droidoffice

import ai.factory.droidoffice.core.Pairing
import ai.factory.droidoffice.core.WorkspaceInsets
import ai.factory.droidoffice.rn.HostIncoming
import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultReactActivityDelegate

/** The React Native workspace (index.mobile.js), and where links and notification taps arrive. */
class MainActivity : ReactActivity() {
    override fun getMainComponentName() = "DroidOffice"

    override fun createReactActivityDelegate(): ReactActivityDelegate = DefaultReactActivityDelegate(this, mainComponentName)

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        // React Native keeps no fragments to restore; the workspace restores its own layout.
        super.onCreate(null)
        enableEdgeToEdge()
        val content = findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val safe = WorkspaceInsets(bars.left, bars.top, bars.right, bars.bottom)
                .withKeyboard(insets.getInsets(WindowInsetsCompat.Type.ime()).bottom)
            // Inset the container that measures ReactRootView, not the React-managed pane itself.
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
            insets
        }
        ViewCompat.requestApplyInsets(content)
        val graph = graph
        splash.setKeepOnScreenCondition { !graph.store.snapshot.value.loaded }
        if (savedInstanceState == null) read(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        read(intent)
    }

    /**
     * The activity is exported (launcher, pairing links, shares), so nothing an intent carries is
     * trusted: links go through the same parser as a scan, and ids must look like ids.
     */
    private fun read(intent: Intent?) {
        intent ?: return
        when (intent.action) {
            Intent.ACTION_VIEW -> intent.dataString?.take(4096)?.let { startActivity(SetupActivity.pair(this, it)) }
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)?.take(4096)?.takeIf { Pairing.parseOrNull(it) != null }?.let { startActivity(SetupActivity.pair(this, it)) }
            ACTION_OPEN_WORKER -> {
                val office = intent.getStringExtra(EXTRA_OFFICE)?.takeIf { ID.matches(it) } ?: return
                val worker = intent.getStringExtra(EXTRA_WORKER)?.takeIf { ID.matches(it) } ?: return
                val floor = intent.getStringExtra(EXTRA_FLOOR)?.takeIf { ID.matches(it) }
                graph.host.incoming(HostIncoming.Worker(office, worker, floor))
            }
            ACTION_OPEN_FLOOR -> {
                val office = intent.getStringExtra(EXTRA_OFFICE)?.takeIf { ID.matches(it) } ?: return
                val floor = intent.getStringExtra(EXTRA_FLOOR)?.takeIf { ID.matches(it) } ?: return
                graph.host.incoming(HostIncoming.Floor(office, floor))
            }
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
