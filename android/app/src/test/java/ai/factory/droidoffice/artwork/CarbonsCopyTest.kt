package ai.factory.droidoffice.artwork

import ai.factory.droidoffice.core.TermPage
import ai.factory.droidoffice.ui.theme.artwork.Artworks
import ai.factory.droidoffice.ui.theme.artwork.TerminalInk
import androidx.compose.ui.graphics.Color
import org.junit.Assert.*
import org.junit.Test

class CarbonsCopyTest {
    @Test fun matchesWebPaletteCropAndTerminal() {
        val theme = requireNotNull(Artworks.find("carbons-copy"))
        assertEquals("Carbon’s Copy", theme.name)
        assertEquals(listOf(.3f, .5f, .74f, .8f), listOf(theme.x, theme.y, theme.glass, theme.speed))
        assertEquals(Color(0xFF07070A), theme.bg)
        assertEquals(Color(0xFF0A0A0E), theme.tint)
        assertEquals(Color(0xFFFF6A1F), theme.accent)
        assertEquals(Color(0xFF7484FF), theme.accent2)
        assertEquals(TerminalInk("#f2f0ed", "#ff6a1f", "#050507", "#3a2418"), theme.terminal)
        with(theme.terminal) {
            assertTrue(""""selectionBackground":"#3a2418"""" in TermPage.colors(foreground, cursor, background, selection))
        }
        assertEquals("""window.office&&office.receive({"t":"colors"})""", TermPage.colors(null, null, null, null))
    }
}
