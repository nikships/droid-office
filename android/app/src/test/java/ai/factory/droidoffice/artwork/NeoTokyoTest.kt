package ai.factory.droidoffice.artwork

import ai.factory.droidoffice.R
import ai.factory.droidoffice.ui.theme.artwork.Artworks
import ai.factory.droidoffice.ui.theme.artwork.TerminalInk
import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Test

class NeoTokyoTest {
    @Test fun matchesWebArtworkAndGlass() {
        val theme = requireNotNull(Artworks.find("neo-tokyo"))
        assertEquals("Neo Tokyo", theme.name)
        assertEquals("Rain on the glass, neon on the river.", theme.blurb)
        assertEquals(R.drawable.art_neo_tokyo, theme.image)
        assertEquals(R.drawable.preview_neo_tokyo, theme.preview)
        assertEquals(listOf(.6f, .5f, .72f, 1f, 0f, .55f), listOf(theme.x, theme.y, theme.glass, theme.speed, theme.shade, theme.veilStart))
        assertEquals(Color.Black.copy(alpha = .55f), theme.veil)
    }

    @Test fun matchesWebPaletteAndTerminal() {
        val theme = requireNotNull(Artworks.find("neo-tokyo"))
        assertEquals(Color(0xFF06060D), theme.bg)
        assertEquals(Color(0xFF090914), theme.tint)
        assertEquals(Color(0xFFF4F1FF), theme.text)
        assertEquals(Color(0xFFAAA5C2), theme.muted)
        assertEquals(Color(0xFFFF3F8E), theme.accent)
        assertEquals(Color(0xFF2FE0FF), theme.accent2)
        assertEquals(Color(0xFFE2DCFF), theme.line)
        assertEquals(TerminalInk("#f4f1ff", "#ff3f8e", "#05050c", "#4a1a33"), theme.terminal)
    }
}
