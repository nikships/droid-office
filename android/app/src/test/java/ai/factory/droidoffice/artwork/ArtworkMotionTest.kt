package ai.factory.droidoffice.artwork

import ai.factory.droidoffice.ui.theme.artwork.artworkAnimates
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ArtworkMotionTest {
    @Test fun eitherReducedMotionSignalDisablesTheArtworkClock() {
        assertFalse(artworkAnimates(0f, 1f))
        assertFalse(artworkAnimates(1f, 0f))
        assertFalse(artworkAnimates(0f, 0f))
        assertTrue(artworkAnimates(1f, 1f))
        assertTrue(artworkAnimates(.5f, 2f))
    }
}
