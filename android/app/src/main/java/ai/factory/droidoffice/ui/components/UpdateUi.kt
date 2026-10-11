package ai.factory.droidoffice.ui.components

import android.content.Intent
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarData
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.core.net.toUri
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.BuildConfig
import ai.factory.droidoffice.core.AppUpdates
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.UpdatePhase
import ai.factory.droidoffice.core.UpdateState
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.theme.Palette
import java.util.Locale

val LocalOpenUpdates = staticCompositionLocalOf<() -> Unit> { error("no update dialog") }

@Composable
fun UpdateSnackbar(data: SnackbarData) {
    Snackbar(
        action = {
            TextButton(onClick = data::performAction, modifier = Modifier.tagged(Tags.Update.NOTICE_OPEN)) {
                Text("Update", color = Palette.Accent)
            }
        },
        dismissAction = {
            IconButton(onClick = data::dismiss, modifier = Modifier.tagged(Tags.Update.NOTICE_DISMISS)) {
                Icon(Icons.Default.Close, "Dismiss", tint = Palette.TextSecondary)
            }
        },
        shape = RoundedCornerShape(10.dp),
        containerColor = Palette.SurfaceHover,
        contentColor = Palette.Text,
        modifier = Modifier.widthIn(max = 560.dp).tagged(Tags.App.SNACKBAR),
    ) { Text(data.visuals.message, Modifier.tagged(Tags.Update.NOTICE_STATUS)) }
}

@Composable
fun UpdateRow() {
    val updates = LocalGraph.current.updates
    val state by updates.state.collectAsStateWithLifecycle()
    val open = LocalOpenUpdates.current
    Column(Modifier.fillMaxWidth().padding(top = 8.dp).tagged(Tags.Update.ROW)) {
        Text(status(state), style = MaterialTheme.typography.bodySmall, modifier = Modifier.tagged(Tags.Update.STATUS))
        TextButton(onClick = {
            open()
            updates.check(force = true)
        }, modifier = Modifier.tagged(Tags.Update.OPEN)) {
            Text(if (state.release == null) "Check for updates" else "Update app")
        }
    }
}

/** The download survives navigation and rotation. Only an explicit Update tap starts it. */
@Composable
fun UpdateDialog(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val updates = LocalGraph.current.updates
    val state by updates.state.collectAsStateWithLifecycle()
    var installAfterDownload by rememberSaveable { mutableStateOf(false) }
    var openingInstaller by remember { mutableStateOf(false) }
    val selfUpdate = BuildConfig.APPLICATION_ID == AppUpdates.PACKAGE

    val installer = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        openingInstaller = false
        // A cancelled installer leaves the verified APK ready for another tap, not a fresh download.
    }

    fun install() {
        val file = updates.state.value.file
        if (file == null || !file.isFile) {
            installAfterDownload = true
            updates.download()
            return
        }
        try {
            updates.clearError()
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
            openingInstaller = true
            installer.launch(
                Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
            )
        } catch (_: Exception) {
            openingInstaller = false
            updates.installFailed("Couldn't open Android's installer. Download the update from GitHub instead.")
        }
    }

    val permission = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (context.packageManager.canRequestPackageInstalls()) install()
        else updates.installFailed("Allow Droid Office to install updates, or download the APK from GitHub instead.")
    }

    fun requestInstall() {
        if (context.packageManager.canRequestPackageInstalls()) install()
        else try {
            permission.launch(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:${context.packageName}".toUri()))
        } catch (_: Exception) {
            updates.installFailed("Couldn't open the install permission settings. Download the update from GitHub instead.")
        }
    }

    LaunchedEffect(state.phase, installAfterDownload) {
        if (installAfterDownload && state.phase == UpdatePhase.Ready) {
            installAfterDownload = false
            requestInstall()
        } else if (state.phase == UpdatePhase.Idle && state.error != null) {
            installAfterDownload = false
        }
    }

    fun browser() {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, AppUpdates.LATEST_URL.toUri()))
        } catch (_: Exception) {
            updates.installFailed("No browser could open GitHub. The latest release is at ${AppUpdates.LATEST_URL}")
        }
    }

    val direct = selfUpdate && state.release?.apk != null
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.tagged(Tags.Update.DIALOG),
        containerColor = Palette.SurfaceRaised,
        shape = RoundedCornerShape(16.dp),
        title = { Text(if (state.release != null) "Update Droid Office" else "App updates") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Installed: ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodySmall)
                Text(status(state), modifier = Modifier.tagged(Tags.Update.DIALOG_STATUS))
                if (state.release != null) {
                    Text(
                        if (!selfUpdate) "Debug builds can't install release updates. Download the release APK instead."
                        else if (!direct) "This release isn't ready for in-app installation. Download its APK from GitHub instead."
                        else "Your paired offices stay on this phone. Android may ask you to allow installs from Droid Office, then confirm the update. Reopen the app after installing.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                if (state.phase == UpdatePhase.Downloading) {
                    val total = state.release?.apk?.size ?: 1
                    LinearProgressIndicator(
                        progress = { (state.bytes.toFloat() / total).coerceIn(0f, 1f) },
                        modifier = Modifier.fillMaxWidth().tagged(Tags.Update.PROGRESS),
                        color = Palette.Accent,
                        trackColor = Palette.SurfaceHigh,
                    )
                    Text("${mb(state.bytes)} / ${mb(total)} MB", style = MaterialTheme.typography.bodySmall)
                }
                state.error?.let { Text(it, color = Palette.Warning, modifier = Modifier.tagged(Tags.Update.ERROR)) }
                if ((state.release != null && direct) || (state.release == null && state.error != null)) {
                    TextButton(onClick = ::browser, modifier = Modifier.tagged(Tags.Update.BROWSER)) { Text("Download newest version") }
                }
            }
        },
        confirmButton = {
            when {
                state.phase == UpdatePhase.Downloading -> TextButton(onClick = {
                    installAfterDownload = false
                    updates.cancelDownload()
                }, modifier = Modifier.tagged(Tags.Update.CANCEL)) { Text("Cancel download") }
                state.release != null && direct -> TextButton(
                    onClick = {
                        if (state.phase == UpdatePhase.Ready) requestInstall()
                        else {
                            installAfterDownload = true
                            updates.download()
                        }
                    },
                    enabled = !state.busy && !openingInstaller,
                    modifier = Modifier.tagged(Tags.Update.INSTALL),
                ) { Text(if (state.phase == UpdatePhase.Ready) "Install update" else "Update now") }
                state.release != null -> TextButton(onClick = ::browser, modifier = Modifier.tagged(Tags.Update.DOWNLOAD)) { Text("Download newest version") }
                else -> TextButton(
                    onClick = { updates.check(force = true) },
                    enabled = !state.busy,
                    modifier = Modifier.tagged(Tags.Update.CHECK),
                ) { Text("Check again") }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, modifier = Modifier.tagged(Tags.Update.DISMISS)) {
                Text(if (state.phase == UpdatePhase.Downloading) "Keep using app" else "Not now", color = Palette.TextSecondary)
            }
        },
    )
}

private fun status(state: UpdateState): String = when (state.phase) {
    UpdatePhase.Checking -> "Checking for updates…"
    UpdatePhase.Downloading -> "Downloading Droid Office ${state.release?.version}…"
    UpdatePhase.Ready -> "Droid Office ${state.release?.version} is ready to install."
    UpdatePhase.Idle -> when {
        state.release != null -> "Droid Office ${state.release.version} is available."
        state.error != null -> "Couldn't check for updates."
        state.checked -> "You're up to date."
        else -> "Check for the latest Android app."
    }
}

private fun mb(bytes: Long) = String.format(Locale.ROOT, "%.1f", bytes / (1024.0 * 1024.0))
