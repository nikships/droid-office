package ai.factory.droidoffice.ui.worker

import android.content.ClipData
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.text.contextmenu.builder.item
import androidx.compose.foundation.text.contextmenu.data.TextContextMenuItem
import androidx.compose.foundation.text.contextmenu.data.TextContextMenuKeys
import androidx.compose.foundation.text.contextmenu.modifier.appendTextContextMenuComponents
import androidx.compose.foundation.text.contextmenu.modifier.filterTextContextMenuComponents
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.Clipboard
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.NativeClipboard
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private object QuoteKey

/**
 * Adds Quote to the menu of text selected anywhere in [content] (messages, thoughts, diffs), as the
 * web Thread's Quote button does: it hands the selection to [onQuote] for the composer to put in the
 * reply. Off while [enabled] is false, when there is no composer to quote into.
 */
@Composable
internal fun QuoteSelections(enabled: Boolean, onQuote: (String) -> Unit, content: @Composable () -> Unit) {
    val system = LocalClipboard.current
    val quoting = remember(system) { QuotingClipboard(system) }
    val scope = rememberCoroutineScope()
    val quote by rememberUpdatedState(onQuote)
    // A selection's menu offers its text only through Copy, and Copy writes it to LocalClipboard: Quote
    // runs Copy against a clipboard that hands the text to the composer instead of the system's.
    val menu = if (!enabled) Modifier else Modifier
        .filterTextContextMenuComponents { component ->
            if (component.key == TextContextMenuKeys.CopyKey && component is TextContextMenuItem) quoting.copy = component
            true
        }
        .appendTextContextMenuComponents {
            item(QuoteKey, "Quote") {
                val copy = quoting.copy
                if (copy == null) {
                    close()
                    return@item
                }
                val ticket = quoting.capture { quote(it) }
                copy.onClick(this)
                // A Copy that wrote nothing must not take the next one.
                scope.launch {
                    delay(1_000)
                    quoting.release(ticket)
                }
            }
        }
    CompositionLocalProvider(LocalClipboard provides quoting) {
        Box(Modifier.fillMaxSize().then(menu)) { content() }
    }
}

private class QuotingClipboard(private val system: Clipboard) : Clipboard {
    var copy: TextContextMenuItem? = null
    private var ticket = 0
    private var take: ((String) -> Unit)? = null

    fun capture(onText: (String) -> Unit): Int {
        take = onText
        return ++ticket
    }

    fun release(ticket: Int) {
        if (ticket == this.ticket) take = null
    }

    override val nativeClipboard: NativeClipboard get() = system.nativeClipboard

    override suspend fun getClipEntry(): ClipEntry? = system.getClipEntry()

    override suspend fun setClipEntry(clipEntry: ClipEntry?) {
        val onText = take ?: return system.setClipEntry(clipEntry)
        take = null
        clipEntry?.clipData?.text()?.let(onText)
    }
}

private fun ClipData.text(): String? = if (itemCount > 0) getItemAt(0).text?.toString() else null
