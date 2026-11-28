package ai.factory.droidoffice.ui.components

import ai.factory.droidoffice.AppGraph
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.ui.theme.Palette
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import platform.Foundation.NSURL
import platform.Foundation.NSUserDefaults
import platform.UIKit.UIApplication
import platform.UIKit.UIApplicationOpenSettingsURLString
import platform.UserNotifications.*
import platform.darwin.dispatch_async
import platform.darwin.dispatch_get_main_queue

internal class NotifyPermission {
    var granted by mutableStateOf(false)
    var asked by mutableStateOf(NSUserDefaults.standardUserDefaults.boolForKey("notifications_asked"))
    private val center = UNUserNotificationCenter.currentNotificationCenter()
    fun refresh() = center.getNotificationSettingsWithCompletionHandler { settings -> dispatch_async(dispatch_get_main_queue()) {
        granted = settings?.authorizationStatus in listOf(UNAuthorizationStatusAuthorized, UNAuthorizationStatusProvisional)
        if (settings != null && settings.authorizationStatus != UNAuthorizationStatusNotDetermined) asked = true
    } }
    fun ask() {
        center.getNotificationSettingsWithCompletionHandler { settings -> dispatch_async(dispatch_get_main_queue()) {
            if (settings?.authorizationStatus == UNAuthorizationStatusDenied) open(UIApplicationOpenSettingsURLString) else {
                asked = true
                NSUserDefaults.standardUserDefaults.setBool(true, "notifications_asked")
                center.requestAuthorizationWithOptions(UNAuthorizationOptionAlert or UNAuthorizationOptionSound) { _, _ -> refresh() }
            }
        } }
    }
}

@Composable internal fun rememberNotifyPermission(): NotifyPermission {
    val permission = remember { NotifyPermission() }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { permission.refresh() }
    return permission
}

private fun open(url: String) = UIApplication.sharedApplication.openURL(NSURL.URLWithString(url)!!, emptyMap<Any?, Any>(), null)

internal val LocalOpenUpdates = staticCompositionLocalOf<() -> Unit> { error("no update dialog") }
// Apple delivers beta updates through TestFlight; never offer an Android APK on an iPhone.
@Composable internal fun UpdateNotice(graph: AppGraph, snackbar: SnackbarHostState, open: () -> Unit) = Unit
@Composable internal fun UpdateSnackbar(data: SnackbarData) = Snackbar(data)
@Composable internal fun UpdateRow() {
    Column(Modifier.fillMaxWidth().padding(top = 8.dp).tagged(Tags.Update.ROW)) {
        Text("Beta updates are delivered through TestFlight.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.tagged(Tags.Update.STATUS))
        TextButton(LocalOpenUpdates.current, Modifier.tagged(Tags.Update.OPEN)) { Text("Check for updates") }
    }
}
@Composable internal fun UpdateDialog(onDismiss: () -> Unit) {
    AlertDialog(onDismissRequest = onDismiss, title = { Text("App updates") }, text = { Text("Open TestFlight to check for a newer Droid Office build.") },
        containerColor = Palette.SurfaceRaised, confirmButton = { TextButton({ open("itms-beta://"); onDismiss() }) { Text("Open TestFlight") } },
        dismissButton = { TextButton(onDismiss) { Text("Cancel") } })
}
