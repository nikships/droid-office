package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FloorSwipeTest {
    private val ids = listOf("home", "office", "web")
    private val distance = 150f

    @Test
    fun swipingLeftGoesToTheNextFloorAndRightToThePrevious() {
        assertEquals("web", FloorSwipe.target(ids, "office", -200f, 10f, distance))
        assertEquals("home", FloorSwipe.target(ids, "office", 200f, -10f, distance))
    }

    @Test
    fun verticalAndSlantedDragsNeverChangeFloors() {
        assertNull(FloorSwipe.target(ids, "office", 0f, 600f, distance))
        assertNull(FloorSwipe.target(ids, "office", -200f, 400f, distance))
        assertNull(FloorSwipe.target(ids, "office", 200f, 101f, distance))
        assertFalse(FloorSwipe.claims(10f, 400f, 24f))
        assertFalse(FloorSwipe.claims(60f, 40f, 24f))
    }

    @Test
    fun shortSwipesStayPut() {
        assertNull(FloorSwipe.target(ids, "office", -149f, 0f, distance))
        assertFalse(FloorSwipe.claims(20f, 0f, 24f))
        assertTrue(FloorSwipe.claims(-30f, 5f, 24f))
    }

    @Test
    fun stopsAtTheFirstAndLastFloorWithoutWrapping() {
        assertNull(FloorSwipe.target(ids, "home", 200f, 0f, distance))
        assertNull(FloorSwipe.target(ids, "web", -200f, 0f, distance))
        assertEquals("office", FloorSwipe.target(ids, "home", -200f, 0f, distance))
        assertEquals("office", FloorSwipe.target(ids, "web", 200f, 0f, distance))
    }

    @Test
    fun unknownOrSingleFloorsGoNowhere() {
        assertNull(FloorSwipe.target(ids, null, -200f, 0f, distance))
        assertNull(FloorSwipe.target(ids, "gone", -200f, 0f, distance))
        assertNull(FloorSwipe.target(listOf("home"), "home", -200f, 0f, distance))
    }
}
