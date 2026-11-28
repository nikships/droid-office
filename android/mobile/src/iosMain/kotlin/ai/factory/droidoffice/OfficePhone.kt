package ai.factory.droidoffice

import ai.factory.droidoffice.core.DeepLinks
import ai.factory.droidoffice.core.Pairing
import ai.factory.droidoffice.data.OfficeStore
import ai.factory.droidoffice.net.NetworkMonitor
import ai.factory.droidoffice.net.OfficeApi
import ai.factory.droidoffice.notify.Alerts
import ai.factory.droidoffice.session.Answers
import ai.factory.droidoffice.session.OfficeConnection
import ai.factory.droidoffice.session.Pairer
import ai.factory.droidoffice.ui.AppRoot
import ai.factory.droidoffice.ui.Incoming
import ai.factory.droidoffice.ui.theme.DroidOfficeTheme
import ai.factory.droidoffice.ui.theme.Palette
import ai.factory.droidoffice.ui.theme.artwork.Artworks
import androidx.compose.ui.window.ComposeUIViewController
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import platform.Foundation.NSBundle
import platform.UIKit.*

class AppVisibility {
    val foreground = MutableStateFlow(false)
    val viewing = MutableStateFlow<String?>(null)
}

class AppGraph internal constructor(incoming: MutableStateFlow<Incoming?>) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val store = OfficeStore(scope)
    val api = OfficeApi()
    val deviceName = UIDevice.currentDevice.name.trim().take(24).ifEmpty { "iPhone" }
    val connection = OfficeConnection(scope, api, store, NetworkMonitor(), deviceName)
    val pairer = Pairer(api, store, deviceName, scope)
    val answers = Answers(connection)
    val visibility = AppVisibility()
    val alerts = Alerts(this, incoming)
    val appVersion = NSBundle.mainBundle.objectForInfoDictionaryKey("CFBundleShortVersionString") as String
    val backgroundConnectionNote = "Keep the office connected briefly after you leave it. iOS pauses the connection when it suspends the app."
    private var backgroundTask = UIBackgroundTaskInvalid

    init {
        scope.launch { store.snapshot.collect { snapshot ->
            Palette.artwork = Artworks.find(snapshot.settings.artworkId)
            Palette.look = snapshot.settings.look
        } }
    }

    internal fun foreground(shown: Boolean) {
        visibility.foreground.value = shown
        if (shown) {
            connection.hold("ui")
            endBackground()
        } else {
            if (store.snapshot.value.settings.stayConnected && backgroundTask == UIBackgroundTaskInvalid) {
                backgroundTask = UIApplication.sharedApplication.beginBackgroundTaskWithName("Finish office updates") { endBackground() }
                if (backgroundTask != UIBackgroundTaskInvalid) connection.hold("background")
            }
            connection.release("ui")
        }
    }
    private fun endBackground() {
        val task = backgroundTask
        if (task == UIBackgroundTaskInvalid) return
        backgroundTask = UIBackgroundTaskInvalid
        connection.release("background")
        UIApplication.sharedApplication.endBackgroundTask(task)
    }
}

/** Swift hosts this controller and forwards scene lifecycle and URL events; navigation stays in Compose. */
object OfficePhone {
    private val incoming = MutableStateFlow<Incoming?>(null)
    private val graph by lazy { AppGraph(incoming) }
    fun viewController(): UIViewController = ComposeUIViewController { DroidOfficeTheme { AppRoot(graph, incoming) } }
    fun foreground(shown: Boolean) = graph.foreground(shown)
    fun open(url: String) {
        if (url.length > 4096) return
        val deep = DeepLinks.parse(url)
        if (deep != null) incoming.value = Incoming.Deep(deep)
        else if (Pairing.parseOrNull(url) != null || url.startsWith("droidoffice://pair", ignoreCase = true)) incoming.value = Incoming.Link(url)
    }
}
