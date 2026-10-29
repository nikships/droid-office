package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationTargetTest {
    private val target = NotificationTarget.parse("office-a", "floor-a", "worker")!!

    @Test(expected = IllegalArgumentException::class)
    fun copyingATargetCannotBypassIdValidation() {
        target.copy(floor = "floor/other")
    }

    @Test
    fun aReplyAndItsResultKeepTheOriginalRecoveryDestinationAfterMovingFloors() {
        assertTrue(target.current("office-a", "office-a", "floor-a", ready = true, workerPresent = true))
        assertFalse(target.current("office-a", "office-a", "floor-b", ready = true, workerPresent = true))
        assertEquals("office-a", target.office)
        assertEquals("floor-a", target.floor)
        assertEquals("worker", target.worker)
        assertEquals("office-a/floor-a/worker", target.key)
    }

    @Test
    fun switchingOfficeCannotRetargetAnOldReplyEvenWithMatchingFloorAndWorkerIds() {
        assertFalse(target.current("office-b", "office-b", "floor-a", ready = true, workerPresent = true))
        // Store and socket can briefly disagree while a switch is being applied.
        assertFalse(target.current("office-b", "office-a", "floor-a", ready = true, workerPresent = true))
        assertFalse(target.current("office-a", "office-b", "floor-a", ready = true, workerPresent = true))
    }

    @Test
    fun disconnectedUnsyncedAndRemovedWorkersNeverQualifyForSend() {
        assertFalse(target.current("office-a", "office-a", "floor-a", ready = false, workerPresent = true))
        assertFalse(target.current("office-a", "office-a", "floor-a", ready = true, workerPresent = false))
        assertFalse(target.current(null, "office-a", "floor-a", ready = true, workerPresent = true))
        assertFalse(target.current("office-a", "office-a", null, ready = true, workerPresent = true))
    }

    @Test
    fun pendingIntentAndNotificationKeysAreScopedBeyondTheWorkerId() {
        assertNotEquals(target.key, NotificationTarget.parse("office-b", "floor-a", "worker")!!.key)
        assertNotEquals(target.key, NotificationTarget.parse("office-a", "floor-b", "worker")!!.key)
        assertNotEquals(target.key, NotificationTarget.parse("office-a", "floor-a", "another-worker")!!.key)
        assertEquals(target.key, NotificationTarget.parse("office-a", "floor-a", "worker")!!.key)
    }

    @Test
    fun missingLegacyTargetsAndMalformedIdsAreRejectedInsteadOfUsingTheCurrentRoute() {
        assertNull(NotificationTarget.parse("office-a", null, "worker"))
        assertNull(NotificationTarget.parse(null, "floor-a", "worker"))
        assertNull(NotificationTarget.parse("office-a", "floor-a", null))
        for (id in listOf("", "with space", "../floor", "a/b", "x".repeat(65))) {
            assertNull(NotificationTarget.parse(id, "floor-a", "worker"))
            assertNull(NotificationTarget.parse("office-a", id, "worker"))
            assertNull(NotificationTarget.parse("office-a", "floor-a", id))
        }
    }

    @Test
    fun invalidNotificationChoicesAndUnsupportedTextAreRefused() {
        val menu = Menu("Continue?", listOf(Choice(1, "Yes"), Choice(2, "No")), 1)
        assertFalse(QuestionAnswers.valid(menu, 99, null, null))
        assertFalse(QuestionAnswers.valid(menu, null, null, "unlisted answer"))
        assertTrue(QuestionAnswers.valid(menu, 1, null, null))
    }
}
