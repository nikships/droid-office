package ai.factory.droidoffice.artwork

import ai.factory.droidoffice.ui.theme.artwork.Artworks
import ai.factory.droidoffice.ui.theme.artwork.TerminalInk
import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Test

class AstralCathedralTest {
    @Test fun matchesWebArtworkAndVeil() {
        val theme = requireNotNull(Artworks.find("astral-cathedral"))
        assertEquals("Astral Cathedral", theme.name)
        assertEquals("Monoliths floating through a lavender haze.", theme.blurb)
        assertEquals(listOf(.5f, .4f, .5f), listOf(theme.x, theme.y, theme.speed))
        assertEquals(listOf(.74f, 0f, .55f), listOf(theme.glass, theme.shade, theme.veilStart))
        assertEquals(Color.Black.copy(alpha = .55f), theme.veil)
    }

    @Test fun matchesWebInkAndTerminal() {
        val theme = requireNotNull(Artworks.find("astral-cathedral"))
        assertEquals(
            listOf(Color(0xFF0D0A16), Color(0xFF120E1F), Color(0xFFF5F0FF), Color(0xFFB6AACB),
                Color(0xFFC39BFF), Color(0xFFF3C46B), Color(0xFFE6DBFF)),
            listOf(theme.bg, theme.tint, theme.text, theme.muted, theme.accent, theme.accent2, theme.line),
        )
        assertEquals(TerminalInk("#f5f0ff", "#c39bff", "#0a0712", "#3a2c5a"), theme.terminal)
    }
}
