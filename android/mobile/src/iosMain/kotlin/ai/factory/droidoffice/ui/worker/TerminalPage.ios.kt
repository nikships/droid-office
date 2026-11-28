@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package ai.factory.droidoffice.ui.worker

import ai.factory.droidoffice.core.PageMsg
import ai.factory.droidoffice.core.TermPage
import ai.factory.droidoffice.ui.theme.Palette
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.UIKitInteropInteractionMode
import androidx.compose.ui.viewinterop.UIKitInteropProperties
import androidx.compose.ui.viewinterop.UIKitView
import platform.CoreGraphics.CGRectMake
import platform.UIKit.UIColor
import platform.UIKit.UIPasteboard
import platform.UIKit.UIPasteboardOptionLocalOnly
import platform.UIKit.UIView
import platform.UIKit.UIViewAutoresizingFlexibleHeight
import platform.UIKit.UIViewAutoresizingFlexibleWidth

internal const val TERMINAL_UNAVAILABLE = "Couldn't open the terminal renderer on this device."

@Composable
internal fun rememberTerminalPage(onMessage: (TerminalPage, PageMsg) -> Unit, onGone: (TerminalPage) -> Unit): TerminalPage =
    remember { AppleTerminalPage(onMessage, onGone) }

private class AppleTerminalPage(onMessage: (TerminalPage, PageMsg) -> Unit, onGone: (TerminalPage) -> Unit) : TerminalPage(onMessage, onGone) {
    private val keyboard = TerminalInput { receive(PageMsg.Input(it)) }
    private val renderer = OfflinePage(
        OfflineAssets.Terminal, TermPage.MAX_IMAGE_B64 + 1024,
        // The renderer's textarea is read-only. A tap can restore our native responder but never
        // grant it permission to type (that only comes from the live, drawn WorkerScreen).
        extraScript = "addEventListener('click', e => { if (e.isTrusted) send(':tap'); }, true);",
        message = { raw ->
            if (raw == ":tap") keyboard.open() else TermPage.decode(raw)?.let {
                if (it is PageMsg.Kitty) keyboard.kittyFlags = it.flags
                receive(it)
            }
        },
        failed = { receive(PageMsg.Unavailable) }, terminated = ::rendererGone,
    )
    private val surface = UIView(CGRectMake(0.0, 0.0, 1.0, 1.0)).apply {
        addSubview(keyboard)
        addSubview(renderer.view)
        renderer.view.setFrame(bounds)
        renderer.view.autoresizingMask = UIViewAutoresizingFlexibleWidth or UIViewAutoresizingFlexibleHeight
        renderer.view.workerSurface(scroll = true, zoom = false)
    }

    @Composable
    override fun Surface(modifier: Modifier, unframed: Boolean, drawn: Boolean) {
        UIKitView(factory = { surface }, modifier = modifier, update = {
            // The cutout removes the worker pane's tint here; put the same tint over the native artwork layer.
            it.backgroundColor = if (unframed) Palette.Pane.let { c ->
                UIColor.colorWithRed(c.red.toDouble(), c.green.toDouble(), c.blue.toDouble(), c.alpha.toDouble())
            } else UIColor.blackColor
            renderer.view.alpha = if (unframed && !drawn) 0.0 else 1.0
        }, properties = UIKitInteropProperties(interactionMode = UIKitInteropInteractionMode.NonCooperative))
    }

    override fun typeDirectly(enabled: Boolean) = keyboard.typeDirectly(enabled)
    override fun setCsiEnter(enabled: Boolean) { keyboard.csiEnter = enabled }
    override fun evaluate(script: String) = renderer.evaluate(script)

    override fun copyIfAttached(text: String) {
        if (surface.window?.keyWindow != true) return
        // OSC 52 only writes to this device's clipboard; never broadcast it through Handoff.
        UIPasteboard.generalPasteboard.setItems(listOf(mapOf("public.utf8-plain-text" to text)), options = mapOf(UIPasteboardOptionLocalOnly to true))
    }

    override fun disposeView() {
        keyboard.removeFromSuperview()
        renderer.close()
    }
}
