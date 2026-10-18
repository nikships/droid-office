package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class QuickKeysTest {
    @Test
    fun idsAreUniqueAndMatchTheirTags() {
        assertEquals(QuickKeys.all.size, QuickKeys.defaultOrder.toSet().size)
        QuickKeys.all.forEach { assertEquals(Tags.Worker.key(it.spoken), "key." + it.id) }
    }

    @Test
    fun slashTypesASlash() {
        val slash = QuickKeys.all.single { it.id == "slash" }
        assertEquals("/", slash.label)
        assertEquals("/", slash.bytes)
    }

    @Test
    fun nothingSavedIsTheDefaultOrder() {
        assertEquals(QuickKeys.all, QuickKeys.arrange(null))
    }

    @Test
    fun theSavedOrderComesBack() {
        val order = QuickKeys.move(QuickKeys.defaultOrder, QuickKeys.defaultOrder.indexOf("slash"), 0)
        assertEquals(order, QuickKeys.decode(QuickKeys.encode(order)))
        assertEquals("slash", QuickKeys.arrange(order).first().id)
    }

    @Test
    fun unknownAndRepeatedIdsAreDropped() {
        val order = QuickKeys.normalize(listOf("enter", "gone_key", "enter") + QuickKeys.defaultOrder)
        assertEquals("enter", order.first())
        assertEquals(QuickKeys.defaultOrder.size, order.size)
    }

    @Test
    fun aKeyANewerReleaseAddsGoesInAfterItsDefaultNeighbour() {
        // An order saved before Slash existed, with Backspace moved to the front.
        val saved = listOf("backspace") + QuickKeys.defaultOrder.filterNot { it == "backspace" || it == "slash" }
        val order = QuickKeys.normalize(saved)
        assertEquals(listOf("backspace", "slash"), order.take(2))
        assertEquals(QuickKeys.defaultOrder.toSet(), order.toSet())
    }

    @Test
    fun aMissingFirstKeyGoesFirst() {
        val order = QuickKeys.normalize(QuickKeys.defaultOrder.drop(1).reversed())
        assertEquals(QuickKeys.defaultOrder.first(), order.first())
    }

    @Test
    fun movesStayInRange() {
        val order = QuickKeys.defaultOrder
        assertEquals(order, QuickKeys.move(order, 0, -1))
        assertEquals(order, QuickKeys.move(order, order.lastIndex, order.size))
        assertEquals(listOf(order[1], order[0]) + order.drop(2), QuickKeys.move(order, 0, 1))
    }

    @Test
    fun theDefaultOrderIsSavedAsNothing() {
        assertNull(QuickKeys.toSaved(QuickKeys.defaultOrder))
        assertNull(QuickKeys.decode(null))
        val moved = QuickKeys.move(QuickKeys.defaultOrder, 0, 1)
        assertEquals(moved, QuickKeys.toSaved(moved))
    }
}
