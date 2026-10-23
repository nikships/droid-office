package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FloorOrderTest {
    private val ids = listOf("home", "office", "web")

    @Test
    fun onlySendsMovesThatChangeTheCurrentOrder() {
        assertTrue(FloorOrder.changed(ids, "web", "home"))
        assertTrue(FloorOrder.changed(ids, "home", null))
        assertFalse(FloorOrder.changed(ids, "home", "office"))
        assertFalse(FloorOrder.changed(ids, "web", null))
        assertFalse(FloorOrder.changed(ids, "gone", "home"))
        assertFalse(FloorOrder.changed(ids, "home", "gone"))
        assertFalse(FloorOrder.changed(ids, "home", "home"))
    }

    @Test
    fun movesEarlierLaterAndToTheEndUsingCanonicalFloorIds() {
        assertEquals(FloorMove("office", "home"), FloorOrder.step(ids, "office", -1))
        assertEquals(FloorMove("home", "web"), FloorOrder.step(ids, "home", 1))
        assertEquals(FloorMove("office", null), FloorOrder.step(ids, "office", 1))
        assertEquals(listOf("home", "office", "web"), ids)
    }

    @Test
    fun refusesEdgesMissingFloorsAndInvalidSteps() {
        assertNull(FloorOrder.step(ids, "home", -1))
        assertNull(FloorOrder.step(ids, "web", 1))
        assertNull(FloorOrder.step(ids, "gone", 1))
        assertNull(FloorOrder.step(ids, "office", 0))
        assertNull(FloorOrder.step(ids, "office", 2))
    }
}
