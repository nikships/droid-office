package ai.factory.droidoffice.artwork

import ai.factory.droidoffice.R
import ai.factory.droidoffice.ui.theme.artwork.Artworks
import ai.factory.droidoffice.ui.theme.artwork.TerminalInk
import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Test

class SakuraMistTest {
    private val theme = requireNotNull(Artworks.find("sakura-mist"))

    @Test fun usesCenteredArtworkAndSakuraVeil() {
        assertEquals("Sakura Mist", theme.name)
        assertEquals("A pastel dawn with cherry blossoms on the wind.", theme.blurb)
        assertEquals(R.drawable.art_sakura_mist, theme.image)
        assertEquals(R.drawable.preview_sakura_mist, theme.preview)
        assertEquals(listOf(.5f, .5f, .7f, .06f, .6f), listOf(theme.x, theme.y, theme.speed, theme.shade, theme.veilStart))
        assertEquals(Color(0xFF28121E).copy(alpha = .35f), theme.veil)
    }

    @Test fun matchesWebInkAndGlass() {
        assertEquals(Color(0xFF1A1117), theme.bg)
        assertEquals(Color(0xFF22161E), theme.tint)
        assertEquals(Color(0xFFFFF4F8), theme.text)
        assertEquals(Color(0xFFD2B6C3), theme.muted)
        assertEquals(Color(0xFFFF8FB8), theme.accent)
        assertEquals(Color(0xFFFFD1E0), theme.accent2)
        assertEquals(Color(0xFFFFE0EC), theme.line)
        assertEquals(.84f, theme.glass, 0f)
        assertEquals(TerminalInk("#fff4f8", "#ff8fb8", "#160e13", "#5a2c40"), theme.terminal)
    }
}
