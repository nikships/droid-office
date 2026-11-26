package ai.factory.droidoffice.artwork

import ai.factory.droidoffice.R
import ai.factory.droidoffice.ui.theme.artwork.Artworks
import ai.factory.droidoffice.ui.theme.artwork.TerminalInk
import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Test

class KyotoFireflyTest {
    @Test fun matchesWebArtworkPaletteAndTerminal() {
        val theme = requireNotNull(Artworks.find("kyoto-firefly"))
        assertEquals("Kyoto Firefly", theme.name)
        assertEquals(R.drawable.art_kyoto_firefly, theme.image)
        assertEquals(R.drawable.preview_kyoto_firefly, theme.preview)
        assertEquals(listOf(.5f, .5f, .72f, .7f, 0f, .55f), listOf(theme.x, theme.y, theme.glass, theme.speed, theme.shade, theme.veilStart))
        assertEquals(Color.Black.copy(alpha = .55f), theme.veil)
        assertEquals(Color(0xFF04100C), theme.bg)
        assertEquals(Color(0xFF061510), theme.tint)
        assertEquals(Color(0xFFEEF6EF), theme.text)
        assertEquals(Color(0xFFA1B8AA), theme.muted)
        assertEquals(Color(0xFFF3C45A), theme.accent)
        assertEquals(Color(0xFF4FD1A1), theme.accent2)
        assertEquals(Color(0xFFD7F0E0), theme.line)
        assertEquals(TerminalInk("#eef6ef", "#f3c45a", "#030d09", "#2c3a1e"), theme.terminal)
    }
}
