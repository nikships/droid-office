package ai.factory.droidoffice.ui.components

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import ai.factory.droidoffice.ui.LocalGraph

/** Whether the app may post notifications, kept current as the owner changes it in Settings, and how to ask. */
@Stable
class NotifyPermission internal constructor() {
    var granted by mutableStateOf(false)
        internal set

    /** Whether the system prompt was ever shown, so the first ask after pairing happens once. */
    var asked by mutableStateOf(false)
        internal set

    internal var onAsk: () -> Unit = {}

    /**
     * Asks with the system prompt; once Android stops showing it (denied twice, or notifications
     * switched off for the app), opens the app's notification settings instead.
     */
    fun ask() = onAsk()
}

@Composable
fun rememberNotifyPermission(): NotifyPermission {
    val context = LocalContext.current
    val alerts = LocalGraph.current.alerts
    val prefs = remember(context) { context.getSharedPreferences("permissions", Context.MODE_PRIVATE) }
    val state = remember(context) {
        NotifyPermission().apply {
            granted = alerts.canNotify()
            asked = prefs.getBoolean(ASKED, false)
        }
    }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { state.granted = alerts.canNotify() }
    state.onAsk = {
        val activity = context.findActivity()
        val denied = Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        val prompt = denied && (!state.asked || (activity != null && ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.POST_NOTIFICATIONS)))
        if (prompt) {
            prefs.edit { putBoolean(ASKED, true) }
            state.asked = true
            launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
        }
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { state.granted = alerts.canNotify() }
    return state
}

private const val ASKED = "notifications_asked"

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
