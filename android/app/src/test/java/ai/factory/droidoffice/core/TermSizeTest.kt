package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TermSizeTest {
    @Test
    fun aPhoneGridFitsAtReadableCellDimensions() {
        val size = TermSize.fit(360f, 600f, 7.5f, 14f)!!
        assertEquals(TermSize(47, 42), size)
        assertTrue((size.cols + 0.5f) * 7.5f <= 360f)
        assertTrue(size.rows * 14f <= 600f)
    }

    @Test
    fun fractionalCellsAreRoundedDownWithHalfACellSpare() {
        assertEquals(TermSize(39, 20), TermSize.fit(400f, 309f, 10f, 15f))
        assertEquals(TermSize(40, 20), TermSize.fit(405f, 309f, 10f, 15f))
    }

    @Test
    fun keyboardAndRotationChangeTheActualGrid() {
        assertEquals(TermSize(47, 20), TermSize.fit(360f, 280f, 7.5f, 14f))
        assertEquals(TermSize(95, 20), TermSize.fit(720f, 280f, 7.5f, 14f))
    }

    @Test
    fun densityDoesNotChangeTheGridButLargerTextDoes() {
        assertEquals(TermSize.fit(360f, 600f, 7.5f, 14f), TermSize.fit(720f, 1200f, 15f, 28f))
        assertEquals(TermSize(23, 21), TermSize.fit(360f, 600f, 15f, 28f))
    }

    @Test
    fun theGridUsesTheServersBounds() {
        assertEquals(TermSize(20, 5), TermSize.fit(1f, 1f, 10f, 15f))
        assertEquals(TermSize(400, 200), TermSize.fit(10000f, 10000f, 1f, 1f))
    }

    @Test
    fun anUnmeasuredOrInvalidViewportDoesNotResize() {
        for (bad in listOf(0f, -1f, Float.NaN, Float.POSITIVE_INFINITY)) {
            assertNull(TermSize.fit(bad, 600f, 7.5f, 14f))
            assertNull(TermSize.fit(360f, bad, 7.5f, 14f))
            assertNull(TermSize.fit(360f, 600f, bad, 14f))
            assertNull(TermSize.fit(360f, 600f, 7.5f, bad))
        }
    }

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
}
