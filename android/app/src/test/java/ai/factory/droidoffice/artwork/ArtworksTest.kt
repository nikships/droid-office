package ai.factory.droidoffice.artwork

import ai.factory.droidoffice.ui.theme.artwork.Artworks
import org.junit.Assert.*
import org.junit.Test

class ArtworksTest {
    @Test fun galleryOnlyContainsInstalledArtworkInWebOrder() {
        val order = listOf("carbons-copy", "nightly-orbit", "neo-tokyo", "kyoto-firefly", "orbital-foundry", "abyssal-biolume", "astral-cathedral", "sakura-mist")
        val ids = Artworks.all.map { it.id }
        assertEquals(order.filter { it in ids }, ids)
        assertTrue(ids.isNotEmpty())
        for (theme in Artworks.all) {
            assertSame(theme, Artworks.find(theme.id))
            assertTrue(theme.name.isNotBlank() && theme.blurb.isNotBlank())
            assertTrue(theme.x in 0f..1f && theme.y in 0f..1f)
            assertTrue(theme.glass in .3f..1f && theme.speed > 0f)
        }
        assertNull(Artworks.find(null))
        assertNull(Artworks.find("removed-theme"))
        assertNull(Artworks.find("aurora"))
    }
}
