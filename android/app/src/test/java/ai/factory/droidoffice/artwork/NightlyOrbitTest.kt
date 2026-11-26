package ai.factory.droidoffice.artwork

import ai.factory.droidoffice.R
import ai.factory.droidoffice.ui.theme.artwork.Artworks
import ai.factory.droidoffice.ui.theme.artwork.TerminalInk
import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Test

class NightlyOrbitTest {
    @Test fun matchesWebArtworkAndPalette() {
        val theme = requireNotNull(Artworks.find("nightly-orbit"))
        assertEquals("Nightly Orbit", theme.name)
        assertEquals("A violet dawn breaking over a sleeping planet.", theme.blurb)
        assertEquals(R.drawable.art_nightly_orbit, theme.image)
        assertEquals(R.drawable.preview_nightly_orbit, theme.preview)
        assertEquals(listOf(.5f, .8f), listOf(theme.x, theme.y))
        assertEquals(listOf(.72f, .6f, 0f, .55f), listOf(theme.glass, theme.speed, theme.shade, theme.veilStart))
        assertEquals(Color.Black.copy(alpha = .55f), theme.veil)
        assertEquals(listOf(Color(0xFF07051A), Color(0xFF0B0820), Color(0xFFF1EEFF), Color(0xFFAEA6CF)),
            listOf(theme.bg, theme.tint, theme.text, theme.muted))
        assertEquals(listOf(Color(0xFFA97BFF), Color(0xFFFF7A45), Color(0xFFD9CCFF)),
            listOf(theme.accent, theme.accent2, theme.line))
        assertEquals(TerminalInk("#f1eeff", "#a97bff", "#05031a", "#33245c"), theme.terminal)
    }
}
