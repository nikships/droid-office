package ai.factory.droidoffice.ui.worker

import androidx.compose.runtime.Composable
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.backhandler.BackHandler
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.semantics.SemanticsPropertyReceiver
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.window.DialogProperties
import platform.Foundation.NSURL
import platform.UIKit.UIColor
import platform.UIKit.UIScrollViewContentInsetAdjustmentBehavior
import platform.WebKit.WKWebView

@OptIn(ExperimentalComposeUiApi::class)
@Composable
internal fun WorkerBackHandler(onBack: () -> Unit) = BackHandler(onBack = onBack)

// UIKit resizes the same composition on rotation; only actually leaving should restore the PTY.
@Composable
internal fun workerConfigurationChange(): () -> Boolean = { false }

internal fun workerDialogProperties() = DialogProperties(usePlatformDefaultWidth = false, usePlatformInsets = false, useSoftwareKeyboardInset = false)

internal fun SemanticsPropertyReceiver.workerKeyTag(tag: String) { testTag = tag }

@OptIn(ExperimentalComposeUiApi::class)
internal fun workerTextClip(label: String, text: String) = ClipEntry.withPlainText(text)

internal fun pictureHost(url: String) = NSURL.URLWithString(url)?.host

/** Compose supplies safe-area padding, labels and (for inline drawings) all gesture handling. */
internal fun WKWebView.workerSurface(scroll: Boolean, zoom: Boolean) {
    opaque = false
    backgroundColor = UIColor.clearColor
    allowsLinkPreview = false
    scrollView.apply {
        backgroundColor = UIColor.clearColor
        contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentBehavior.UIScrollViewContentInsetAdjustmentNever
        bounces = false
        scrollEnabled = scroll
        pinchGestureRecognizer?.enabled = zoom
        showsHorizontalScrollIndicator = zoom
        showsVerticalScrollIndicator = zoom
    }
}
