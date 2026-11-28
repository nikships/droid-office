@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package ai.factory.droidoffice.ui.worker

import ai.factory.droidoffice.core.RichPage
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.UIKitInteropInteractionMode
import androidx.compose.ui.viewinterop.UIKitInteropProperties
import androidx.compose.ui.viewinterop.UIKitView

@Composable
internal fun rememberRichPage(zoom: Boolean, onMessage: (RichPage.Msg) -> Unit): RichBlockPage =
    remember(zoom) { AppleRichPage(zoom, onMessage) }

/** Inline drawings don't take gestures away from the Thread. The full-screen viewer owns pinch and pan. */
private class AppleRichPage(private val zoom: Boolean, onMessage: (RichPage.Msg) -> Unit) : RichBlockPage(onMessage) {
    private val page = OfflinePage(
        OfflineAssets.Rich, maxMessage = 4 * 1024 * 1024,
        extraScript = if (!zoom) "" else """
            addEventListener('DOMContentLoaded', () => {
              document.querySelector('meta[name=viewport]').content = 'width=device-width, initial-scale=1, minimum-scale=0.25, maximum-scale=4';
              visualViewport.addEventListener('resize', () => send(':zoom:' + Math.round(100 * visualViewport.scale)));
            });
        """.trimIndent(),
        message = { raw ->
            if (zoom && raw.startsWith(":zoom:")) raw.removePrefix(":zoom:").toIntOrNull()?.let { onZoom?.invoke(it.coerceIn(25, 400)) }
            else RichPage.decode(raw)?.let(::received)
        },
        failed = { received(RichPage.Msg.Drawn(-1, false, 0, null, "The page stopped")) },
    )

    init { page.view.workerSurface(scroll = zoom, zoom = zoom) }

    @Composable
    override fun Surface(modifier: Modifier) = UIKitView(factory = { page.view }, modifier = modifier, properties = UIKitInteropProperties(
        interactionMode = if (zoom) UIKitInteropInteractionMode.NonCooperative else null,
    ))

    override fun changeZoom(inward: Boolean) {
        if (zoom) page.view.scrollView.apply {
            val step = if (inward) 1.25 else 0.8
            setZoomScale((zoomScale * step).coerceIn(minimumZoomScale, maximumZoomScale), animated = true)
        }
    }

    override fun evaluate(script: String) = page.evaluate(script)
    override fun disposeView() = page.close()
}
