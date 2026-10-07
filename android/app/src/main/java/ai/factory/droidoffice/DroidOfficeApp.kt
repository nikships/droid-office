package ai.factory.droidoffice

import android.app.Application
import android.content.Context
import android.os.Build
import android.provider.Settings
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import ai.factory.droidoffice.data.OfficeStore
import ai.factory.droidoffice.net.NetworkMonitor
import ai.factory.droidoffice.net.OfficeApi
import ai.factory.droidoffice.notify.Alerts
import ai.factory.droidoffice.notify.StayConnectedService
import ai.factory.droidoffice.session.OfficeConnection
import ai.factory.droidoffice.session.Pairer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class DroidOfficeApp : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
    }
}

val Context.graph: AppGraph get() = (applicationContext as DroidOfficeApp).graph

/** Whether the app is on screen, and which worker's terminal is open, so alerts don't repeat what's in view. */
class AppVisibility {
    private val _foreground = MutableStateFlow(false)
    val foreground: StateFlow<Boolean> = _foreground.asStateFlow()
    val viewing = MutableStateFlow<String?>(null)

    internal fun set(on: Boolean) {
        _foreground.value = on
    }
}

/** The app's long-lived objects, made once per process. */
class AppGraph(val app: Application) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val store = OfficeStore(app, scope)
    val api = OfficeApi()
    val network = NetworkMonitor(app)
    val deviceName: String = deviceName(app)
    val connection = OfficeConnection(scope, api, store, network, deviceName)
    val pairer = Pairer(api, store, deviceName, scope)
    val visibility = AppVisibility()
    val alerts = Alerts(app, scope, connection, store, visibility)

    init {
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                visibility.set(true)
                connection.hold(UI_HOLD)
                if (store.snapshot.value.settings.stayConnected) StayConnectedService.start(app)
            }

            override fun onStop(owner: LifecycleOwner) {
                visibility.set(false)
                connection.release(UI_HOLD)
            }
        })
    }

    private companion object {
        const val UI_HOLD = "ui"

        /** What the office shows as who hired a worker: the phone's own name when the owner set one. */
        fun deviceName(context: Context): String {
            val named = runCatching { Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
            val model = Build.MODEL.orEmpty().let { m ->
                val maker = Build.MANUFACTURER.orEmpty()
                if (m.startsWith(maker, ignoreCase = true) || maker.equals("Google", ignoreCase = true)) m else "$maker $m"
            }
            val name = named?.takeIf { it.isNotBlank() } ?: model.ifBlank { "Android" }
            return name.trim().take(24).trim()
        }
    }
}
