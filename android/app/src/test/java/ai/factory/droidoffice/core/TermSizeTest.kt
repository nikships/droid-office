package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TermSizeTest {
    private val desktop = TermSize(120, 40)
    private val phone = TermSize(47, 42)
    private val keyboard = TermSize(47, 20)

    @Test
    fun phoneModeIsOptInAndRemembersThePreviousSize() {
        val sizing = PhoneSizing()
        assertNull(sizing.restore(desktop))
        assertEquals(phone, sizing.request(desktop, phone))
        sizing.sent(phone)
        assertNull(sizing.request(desktop, phone))
        assertNull(sizing.request(phone, phone))
        assertEquals(desktop, sizing.restore(phone))
        sizing.release()
        assertNull(sizing.restore(desktop))
    }

    @Test
    fun layoutChangesResizeWithoutReplacingTheOriginalSize() {
        val sizing = PhoneSizing()
        sizing.request(desktop, phone)
        sizing.sent(phone)
        assertEquals(keyboard, sizing.request(phone, keyboard))
        sizing.sent(keyboard)
        assertEquals(desktop, sizing.restore(keyboard))
    }

    @Test
    fun failedSendsAndReconnectsCanRetry() {
        val sizing = PhoneSizing()
        assertEquals(phone, sizing.request(desktop, phone))
        assertEquals(phone, sizing.request(desktop, phone))
        sizing.sent(phone)
        sizing.disconnected()
        assertEquals(phone, sizing.request(desktop, phone))
        assertEquals(desktop, sizing.restore(phone))
    }

    @Test
    fun anotherWindowCanClaimTheSharedTerminalWithoutAResizeLoop() {
        val sizing = PhoneSizing()
        sizing.request(desktop, phone)
        sizing.sent(phone)
        val other = TermSize(100, 30)
        assertNull(sizing.request(other, phone))
        assertNull(sizing.restore(other))
    }

    @Test
    fun switchingOffBeforeTheResizeArrivesRestoresTheSize() {
        val sizing = PhoneSizing()
        sizing.request(desktop, phone)
        sizing.sent(phone)
        assertEquals(desktop, sizing.restore(desktop))
    }

    @Test
    fun savedSizingRestoresAcrossRotationAndReconnects() {
        val sizing = PhoneSizing(desktop, listOf(phone))
        sizing.disconnected()
        assertNull(sizing.request(phone, phone))
        assertEquals(desktop, sizing.restore(phone))
    }

    @Test
    fun anAlreadyPhoneSizedTerminalNeedsNoResizeOrRestore() {
        val sizing = PhoneSizing()
        assertNull(sizing.request(phone, phone))
        assertNull(sizing.restore(phone))
        assertNull(sizing.request(desktop, phone))
    }

    @Test
    fun aFailedRestoreIsKeptForReconnect() {
        val sizing = PhoneSizing(desktop, listOf(phone))
        assertEquals(desktop, sizing.restore(phone))
        sizing.disconnected()
        assertEquals(desktop, sizing.restore(phone))
        sizing.release()
        assertNull(sizing.restore(phone))
    }

    @Test
    fun closingTheKeyboardCancelsAnInFlightSmallerGrid() {
        val sizing = PhoneSizing(desktop, listOf(phone))
        assertEquals(keyboard, sizing.request(phone, keyboard))
        sizing.sent(keyboard)
        assertEquals(phone, sizing.request(phone, phone))
        sizing.sent(phone)
        assertNull(sizing.request(keyboard, phone))
    }

    @Test
    fun switchingOffDuringAResizeRestoresFromTheEarlierPhoneGrid() {
        val sizing = PhoneSizing(desktop, listOf(phone))
        sizing.sent(keyboard)
        assertEquals(desktop, sizing.restore(phone))
        assertEquals(desktop, PhoneSizing(sizing.original, sizing.sentSizes).restore(phone))
    }

    @Test
    fun theDesktopTypingTakesTheSizeBack() {
        val sizing = PhoneSizing()
        sizing.request(desktop, phone)
        sizing.sent(phone)
        // Still at the desktop's size while the resize is on its way: not taken over.
        assertFalse(sizing.takenOver(desktop))
        assertFalse(sizing.takenOver(phone))
        assertFalse(sizing.takenOver(keyboard.also { sizing.sent(it) }))
        assertTrue(sizing.takenOver(TermSize(100, 30)))
        // The desktop's window at the size it had before counts too, once the phone's size had landed.
        assertTrue(sizing.takenOver(desktop))
    }

    @Test
    fun nothingIsTakenOverBeforeThePhoneResizesOrAfterItLetsGo() {
        val sizing = PhoneSizing()
        assertFalse(sizing.takenOver(desktop))
        sizing.request(desktop, phone)
        sizing.sent(phone)
        sizing.takenOver(phone)
        sizing.release()
        assertFalse(sizing.takenOver(TermSize(100, 30)))
    }

    @Test
    fun theOfficeRestoringTheSizeWhileThePhoneWasAwayIsNotATakeover() {
        val sizing = PhoneSizing()
        sizing.request(desktop, phone)
        sizing.sent(phone)
        sizing.takenOver(phone)
        sizing.disconnected()
        assertFalse(sizing.takenOver(desktop))
        assertEquals(phone, sizing.request(desktop, phone))
        // Someone else's size seen on the way back still is.
        assertTrue(sizing.takenOver(TermSize(100, 30)))
    }
}
