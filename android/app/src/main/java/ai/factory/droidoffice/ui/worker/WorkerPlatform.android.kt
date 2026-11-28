package ai.factory.droidoffice.ui.worker

import android.content.ClipData
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.semantics.SemanticsPropertyReceiver
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.window.DialogProperties

@Composable
internal fun WorkerBackHandler(onBack: () -> Unit) = BackHandler(onBack = onBack)

@Composable
internal fun workerConfigurationChange(): () -> Boolean {
    val activity = LocalActivity.current
    return { activity?.isChangingConfigurations == true }
}

internal fun workerDialogProperties() = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)

internal fun SemanticsPropertyReceiver.workerKeyTag(tag: String) {
    testTagsAsResourceId = true
    testTag = tag
}

internal fun workerTextClip(label: String, text: String) = ClipEntry(ClipData.newPlainText(label, text))

internal fun pictureHost(url: String) = runCatching { java.net.URI(url).host }.getOrNull()
