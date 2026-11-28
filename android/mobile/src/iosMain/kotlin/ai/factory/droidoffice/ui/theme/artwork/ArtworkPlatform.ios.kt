package ai.factory.droidoffice.ui.theme.artwork

import ai.factory.droidoffice.core.Glass
import ai.factory.droidoffice.ui.theme.bundledBitmap
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.viewinterop.UIKitInteropProperties
import androidx.compose.ui.viewinterop.UIKitView
import androidx.compose.ui.window.ComposeUIView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import platform.Foundation.NSNotificationCenter
import platform.Foundation.NSOperationQueue
import platform.UIKit.UIAccessibilityIsReduceMotionEnabled
import platform.UIKit.UIAccessibilityReduceMotionStatusDidChangeNotification

// A WKWebView sits in a cutout in Compose's Metal surface. Draw the one wallpaper beneath
// native views too, so the terminal sees it and floating Compose controls still cover the text.
@OptIn(ExperimentalComposeUiApi::class)
@Composable internal fun ArtworkLayer(content: @Composable () -> Unit) {
    val draw by rememberUpdatedState(content)
    UIKitView(factory = { ComposeUIView { draw() }.apply { userInteractionEnabled = false } },
        modifier = Modifier.fillMaxSize(), properties = UIKitInteropProperties(interactionMode = null))
}

private val grays = mutableMapOf<String, Int>()

@Composable internal fun artworkGray(image: String): Int? {
    var gray by remember(image) { mutableStateOf(grays[image]) }
    LaunchedEffect(image) {
        if (gray == null) gray = withContext(Dispatchers.Default) {
            val bitmap = bundledBitmap(image)
            val pixels = bitmap.toPixelMap()
            val w = (bitmap.width / 16).coerceAtLeast(1)
            Glass.brightGray(IntArray(w * (bitmap.height / 16).coerceAtLeast(1)) { pixels[(it % w) * 16, (it / w) * 16].toArgb() })
        }.also { grays[image] = it }
    }
    return gray
}

@Composable internal fun artworkMotionEnabled(): Boolean {
    var reduced by remember { mutableStateOf(UIAccessibilityIsReduceMotionEnabled()) }
    DisposableEffect(Unit) {
        val center = NSNotificationCenter.defaultCenter
        val observer = center.addObserverForName(UIAccessibilityReduceMotionStatusDidChangeNotification, null, NSOperationQueue.mainQueue) {
            reduced = UIAccessibilityIsReduceMotionEnabled()
        }
        onDispose { center.removeObserver(observer) }
    }
    return artworkAnimates(if (reduced) 0f else 1f, rememberCoroutineScope().coroutineContext[MotionDurationScale]?.scaleFactor ?: 1f)
}
