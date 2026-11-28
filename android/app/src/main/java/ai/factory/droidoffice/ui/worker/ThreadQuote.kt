package ai.factory.droidoffice.ui.worker

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.text.contextmenu.builder.item
import androidx.compose.foundation.text.contextmenu.modifier.appendTextContextMenuComponents
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.text.selection.rememberSelectionState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Modifier

private object QuoteKey
private val LocalQuote = compositionLocalOf<((String) -> Unit)?> { null }

/**
 * Adds Quote to the menu of text selected anywhere in [content] (messages, thoughts, diffs), as the
 * web Thread's Quote button does: it hands the selection to [onQuote] for the composer to put in the
 * reply. Off while [enabled] is false, when there is no composer to quote into.
 */
@Composable
internal fun QuoteSelections(enabled: Boolean, onQuote: (String) -> Unit, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalQuote provides onQuote.takeIf { enabled }) {
        Box(Modifier.fillMaxSize()) { content() }
    }
}

/** Quote the selected passage directly. Neither reading nor temporarily replacing the clipboard is necessary. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun ThreadSelection(content: @Composable () -> Unit) {
    val quote = LocalQuote.current
    val state = rememberSelectionState()
    val menu = if (quote == null) Modifier else Modifier.appendTextContextMenuComponents {
        item(QuoteKey, "Quote") {
            val text = state.selectedTexts.joinToString("\n") { it.text }
            if (text.isNotEmpty()) quote(text)
            state.clear()
            close()
        }
    }
    SelectionContainer(state, menu, content)
}
