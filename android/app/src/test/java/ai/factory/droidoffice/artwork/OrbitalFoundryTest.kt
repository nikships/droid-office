package ai.factory.droidoffice.artwork

import ai.factory.droidoffice.R
import ai.factory.droidoffice.ui.theme.artwork.Artworks
import ai.factory.droidoffice.ui.theme.artwork.TerminalInk
import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Test

class OrbitalFoundryTest {
    private val theme = requireNotNull(Artworks.find("orbital-foundry"))

    @Test fun usesFoundryArtworkCropAndOverlaySettings() {
        assertEquals("Orbital Foundry", theme.name)
        assertEquals("A ring forge burning against the black of space.", theme.blurb)
        assertEquals(R.drawable.art_orbital_foundry, theme.image)
        assertEquals(R.drawable.preview_orbital_foundry, theme.preview)
        assertEquals(.5f to .45f, theme.x to theme.y)
        assertEquals(1.1f, theme.speed, 0f)
        assertEquals(0f, theme.shade, 0f)
        assertEquals(.55f, theme.veilStart, 0f)
        assertEquals(Color.Black.copy(alpha = .55f), theme.veil)
    }

    @Test fun matchesWebChromeAndTerminalPalette() {
        assertEquals(Color(0xFF0A0505), theme.bg)
        assertEquals(Color(0xFF100707), theme.tint)
        assertEquals(Color(0xFFFBEFEA), theme.text)
        assertEquals(Color(0xFFC0A59C), theme.muted)
        assertEquals(Color(0xFFFF5A36), theme.accent)
        assertEquals(Color(0xFFFFB347), theme.accent2)
        assertEquals(Color(0xFFFFD9CC), theme.line)
        assertEquals(.74f, theme.glass, 0f)
        assertEquals(TerminalInk("#fbefea", "#ff5a36", "#080303", "#4a1d14"), theme.terminal)
    }
}
