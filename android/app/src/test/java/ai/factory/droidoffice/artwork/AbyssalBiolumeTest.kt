package ai.factory.droidoffice.artwork

import ai.factory.droidoffice.R
import ai.factory.droidoffice.ui.theme.artwork.Artworks
import ai.factory.droidoffice.ui.theme.artwork.TerminalInk
import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Test

class AbyssalBiolumeTest {
    @Test fun matchesWebArtworkAndCoverCrop() {
        val theme = requireNotNull(Artworks.find("abyssal-biolume"))
        assertEquals("Abyssal", theme.name)
        assertEquals("Bioluminescent currents deep in the trench.", theme.blurb)
        assertEquals(R.drawable.art_abyssal_biolume, theme.image)
        assertEquals(R.drawable.preview_abyssal_biolume, theme.preview)
        assertEquals(listOf(.5f, .4f, .7f), listOf(theme.x, theme.y, theme.speed))
        assertEquals(listOf(0f, .55f), listOf(theme.shade, theme.veilStart))
        assertEquals(Color.Black.copy(alpha = .55f), theme.veil)
    }

    @Test fun matchesWebGlassAndTerminalPalette() {
        val theme = requireNotNull(Artworks.find("abyssal-biolume"))
        assertEquals(.72f, theme.glass, 0f)
        assertEquals(Color(0xFF020B14), theme.bg)
        assertEquals(Color(0xFF03101C), theme.tint)
        assertEquals(Color(0xFFEAF8FB), theme.text)
        assertEquals(Color(0xFF93B4BF), theme.muted)
        assertEquals(Color(0xFF2EE6D6), theme.accent)
        assertEquals(Color(0xFF7A6BFF), theme.accent2)
        assertEquals(Color(0xFFC9F4FF), theme.line)
        assertEquals(TerminalInk("#eaf8fb", "#2ee6d6", "#010910", "#0f3a44"), theme.terminal)
    }
}
