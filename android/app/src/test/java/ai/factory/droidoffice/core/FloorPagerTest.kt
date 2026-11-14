package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FloorPagerTest {
    private val ids = listOf("home", "office", "web")

    @Test
    fun pagesFollowTheBuildingsOrder() {
        assertEquals(0, FloorPager.page(ids, "home"))
        assertEquals(2, FloorPager.page(ids, "web"))
        assertNull(FloorPager.page(ids, "gone"))
        assertNull(FloorPager.page(ids, null))
    }

    @Test
    fun settlingOnAnotherFloorAsksForItOnce() {
        assertEquals("web", FloorPager.request(ids, 2, "office", null))
        assertNull(FloorPager.request(ids, 2, "office", "web"))
        assertEquals("home", FloorPager.request(ids, 0, "office", "web"))
    }

    @Test
    fun settlingWhereTheOfficeIsAsksNothing() {
        assertNull(FloorPager.request(ids, 1, "office", null))
        assertNull(FloorPager.request(ids, 3, "office", null))
        assertNull(FloorPager.request(emptyList(), 0, null, null))
    }

    @Test
    fun slidingBackBeforeTheOfficeMovedAsksForTheOfficesFloorAgain() {
        // Slid office → web and straight back: the office is still going to web, so it must be asked back.
        assertEquals("office", FloorPager.request(ids, 1, "office", "web"))
    }

    @Test
    fun floorsOnTheWayToARequestedOneDontPullThePagerBack() {
        // Slid home → office → web: the office's view of "office" arrives while "web" is still on its way.
        assertFalse(FloorPager.follows("office", "web"))
        assertTrue(FloorPager.follows("web", "web"))
        assertTrue(FloorPager.follows("office", null))
    }

    @Test
    fun otherFloorsShowTheBuildingRoster() {
        val here = worker("a")
        val there = worker("b")
        val workers = mapOf("a" to here)
        val building = mapOf("home" to mapOf("a" to here), "web" to mapOf("b" to there))
        assertEquals(listOf(here), FloorPager.workers(FloorInfo("home", workers = 1), "home", workers, building)?.toList())
        assertEquals(listOf(there), FloorPager.workers(FloorInfo("web", workers = 1), "home", workers, building)?.toList())
    }

    @Test
    fun aFloorOutsideTheRosterIsUnknownUnlessItIsEmpty() {
        assertNull(FloorPager.workers(FloorInfo("web", workers = 2), "home", emptyMap(), emptyMap()))
        assertEquals(emptyList<WorkerInfo>(), FloorPager.workers(FloorInfo("web", workers = 0), "home", emptyMap(), emptyMap())?.toList())
        // The phone's own floor is always known, even before its first worker.
        assertEquals(emptyList<WorkerInfo>(), FloorPager.workers(FloorInfo("home", workers = 3), "home", emptyMap(), emptyMap())?.toList())
    }

    private fun worker(id: String) = WorkerInfo(id = id)
}
