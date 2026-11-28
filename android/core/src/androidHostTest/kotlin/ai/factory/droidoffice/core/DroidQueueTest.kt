package ai.factory.droidoffice.core

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DroidQueueTest {
    private val fixture = OfficeJson.parseToJsonElement(javaClass.classLoader!!.getResource("droid-queue-golden.json")!!.readText()).jsonObject

    private fun row(o: kotlinx.serialization.json.JsonObject) =
        DroidQueue.Row(o.getValue("text").jsonPrimitive.content, o.getValue("cut").jsonPrimitive.boolean, o.getValue("more").jsonPrimitive.int)

    @Test
    fun readsTheSameScreensAsTheWeb() {
        for (case in fixture.getValue("cases").jsonArray.map { it.jsonObject }) {
            val rows = case.getValue("rows").jsonArray.map { it.jsonPrimitive.content }
            val expected = case.getValue("expected").let { if (it is JsonNull) null else it.jsonArray.map { r -> row(r.jsonObject) } }
            assertEquals(case.getValue("name").jsonPrimitive.content, expected, DroidQueue.read(rows))
        }
    }

    @Test
    fun matchesWholeMessagesToTheirRowsAsTheWebDoes() {
        for (m in fixture.getValue("matches").jsonArray.map { it.jsonObject }) {
            assertEquals(m.toString(), m.getValue("shows").jsonPrimitive.boolean, DroidQueue.showsAs(row(m.getValue("row").jsonObject), m.getValue("text").jsonPrimitive.content))
        }
    }

    @Test
    fun theQueueShowsDroidsRowsWithTheWholeTextSentFromHere() {
        val q = ThreadQueue()
        q.sent("Line one of a multi-line queued message\nline two of it", hasImage = false, after = 1, at = 1_000)
        q.sent("not drawn yet", hasImage = false, after = 1, at = 2_000)
        val droid = listOf(DroidQueue.Row("From the desktop", cut = false, more = 0), DroidQueue.Row("Line one of a multi-line queued message", cut = false, more = 1))
        val shown = q.shown(droid, now = 2_500)
        assertEquals(listOf("From the desktop", "Line one of a multi-line queued message\nline two of it", "not drawn yet"), shown.map { it.text })
        assertEquals(listOf(false, false, false), shown.map { it.preview })
        // Droid drained the first of them: the other stays a few seconds for the conversation to catch up, then goes.
        assertEquals(2, q.shown(emptyList(), now = 5_000).size)
        assertEquals(listOf("Line one of a multi-line queued message\nline two of it"), q.shown(emptyList(), now = 6_100).map { it.text })
        assertTrue(q.shown(emptyList(), now = 6_600).isEmpty())
        assertTrue(q.pending.isEmpty())
    }

    @Test
    fun withoutTheScreenEverythingSentShows() {
        val q = ThreadQueue()
        q.sent("a", hasImage = false, after = 1, at = 0)
        assertEquals(listOf("a"), q.shown(null, now = 60_000).map { it.text })
        assertEquals(1, q.pending.size)
    }

    @Test
    fun aCutRowSaysItIsAPreview() {
        val shown = ThreadQueue().shown(listOf(DroidQueue.Row("Long", cut = true, more = 0), DroidQueue.Row("Two", cut = false, more = 2)), now = 0)
        assertEquals(listOf(true, true), shown.map { it.preview })
        assertEquals(listOf(0, 2), shown.map { it.more })
    }
}

class DroidPendingTest {
    private val box = listOf("╭──────────╮", "│ > draft  │", "╰──────────╯")

    @Test
    fun readsSteeringThenQueuedInReviewOrder() {
        val rows = listOf(
            "Steering messages:",
            "Look at the tests first",
            "+2 more steering items",
            "Queued messages:",
            "Then open a PR… ",
            "Write notes (2 more lines)",
            "Ctrl+R to modify queue   Ctrl+G to pull top   Ctrl+X to clear queue",
            "⠋ Thinking... (Press ESC to stop)",
        ) + box
        val snap = DroidQueue.readPending(rows)!!
        assertEquals(listOf(DroidQueue.Group.Steering, DroidQueue.Group.Queued, DroidQueue.Group.Queued), snap.items.map { it.group })
        assertEquals(DroidQueue.Row("Then open a PR", cut = true, more = 0), snap.items[1].row)
        assertEquals(DroidQueue.Row("Write notes", cut = false, more = 2), snap.items[2].row)
        assertEquals(2, snap.moreSteering)
        assertEquals(5, snap.total)
        assertFalse(snap.reviewActive)
        assertEquals(listOf("Then open a PR", "Write notes"), DroidQueue.read(rows)!!.map { it.text })
    }

    @Test
    fun knowsWhenReviewIsOpen() {
        val rows = listOf("Queued messages:", "One", "↑↓ scroll · Enter send now · Ctrl+D delete · Esc/Ctrl+R exit", "Press ESC to stop") + box
        assertTrue(DroidQueue.readPending(rows)!!.reviewActive)
    }

    @Test
    fun overflowedCountsCannotCrashAQueuePreview() {
        val rows = listOf(
            "Steering messages:", "Keep this prompt (999999999999999999999 more lines)",
            "+999999999999999999999 more steering items",
            "Queued messages:", "Next prompt (999999999999999999999 more lines)",
            "+999999999999999999999 more queued items",
            "Ctrl+X to clear queue", "Press ESC to stop",
        ) + box
        val pending = DroidQueue.readPending(rows)!!
        assertEquals(listOf("Keep this prompt", "Next prompt"), pending.items.map { it.row.text })
        assertEquals(listOf(0, 0), pending.items.map { it.row.more })
        assertEquals(0, pending.moreSteering)
        assertEquals(0, pending.moreQueued)
        assertEquals(listOf(DroidQueue.Row("Next prompt", false, 0)), DroidQueue.read(rows))
    }

    @Test
    fun theNearestHintWinsAndClearTakesPriorityOnTheSameRow() {
        val rows = listOf(
            "Steering messages:", "First",
            "Queued messages:", "Second",
            "Enter send now · Ctrl+D delete · Esc/Ctrl+R exit",
            "Ctrl+X to clear queue", "Press ESC to stop",
        ) + box
        val pending = DroidQueue.readPending(rows)!!
        assertFalse(pending.reviewActive)
        assertEquals(listOf("First", "Second"), pending.items.map { it.row.text })
        assertFalse(DroidQueue.readPending(listOf(
            "Queued messages:", "One",
            "Enter send now · Ctrl+D delete · Ctrl+X to clear queue",
            "Press ESC to stop",
        ) + box)!!.reviewActive)
        assertTrue(DroidQueue.readPending(listOf(
            "Queued messages:", "One", "Ctrl+X to clear queue",
            "Enter send now · Ctrl+D delete · Esc/Ctrl+R exit", "Press ESC to stop",
        ) + box)!!.reviewActive)
    }

    @Test
    fun nothingPendingOrNotDroid() {
        assertEquals(0, DroidQueue.readPending(listOf("hello") + box)!!.total)
        assertEquals(null, DroidQueue.readPending(listOf("no box here")))
        // A quoted heading in a reply at rest isn't a queue.
        assertEquals(0, DroidQueue.readPending(listOf("Queued messages:", "x", "Ctrl+X to clear queue") + box)!!.total)
    }
}
