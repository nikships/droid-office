package ai.factory.droidoffice.core

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeLifecycleTest {
    @Test
    fun pickerDestinationDoesNotFollowOfficeFloorRouteOrSocketChanges() {
        val target = UploadTarget("office-a", "floor-a", 1, "route-a")
        assertTrue(target.matches("office-a", "floor-a", 1, "route-a"))
        assertFalse(target.matches("office-b", "floor-a", 1, "route-b"))
        assertFalse(target.matches("office-a", "floor-b", 1, "route-a"))
        assertFalse(target.matches("office-a", "floor-a", null, "route-a"))
        assertFalse(target.matches("office-a", "floor-a", 2, "route-a"))
        assertFalse(target.matches("office-a", "floor-a", 1, "route-b"))
        // An upload that finishes after expiry is still cleaned on its captured route and floor.
        assertEquals("office-a", target.office)
        assertEquals("floor-a", target.floor)
        assertEquals("route-a", target.route)
    }

    @Test
    fun oldDrawCannotUnlockInputOnANewSocket() {
        val old = TerminalFreshness(1)
        assertTrue(old.snapshot(1))
        old.drawn() // Delivered only after socket 2 has welcomed.
        assertFalse(old.ready(2))
        val fresh = TerminalFreshness(2)
        fresh.drawn() // A page-ready or empty draw is not a snapshot.
        assertFalse(fresh.ready(2))
        assertFalse(fresh.snapshot(1))
        fresh.drawn()
        assertFalse(fresh.ready(2))
        assertTrue(fresh.snapshot(2))
        fresh.drawn()
        assertTrue(fresh.ready(2))
        assertFalse(fresh.ready(null))
    }

    @Test
    fun aPageCreatedWithoutALiveSocketNeverAdoptsALaterSnapshot() {
        val page = TerminalFreshness(null)
        assertFalse(page.snapshot(null))
        assertFalse(page.snapshot(1))
        page.drawn()
        assertFalse(page.ready(1))
        assertFalse(page.ready(null))
    }

    @Test
    fun imageOriginsAreSafeForConcurrentNativeSendsAndMainThreadCleanup() {
        val origins = ImageOrigins<String>(max = 20)
        val executor = Executors.newFixedThreadPool(4)
        try {
            val tasks = (1..4).map { thread ->
                executor.submit {
                    repeat(2_000) { n ->
                        val id = "$thread-$n"
                        origins.record(id, "office", "floor", "route")
                        if (n % 2 == 0) origins.sent(listOf(id)) else origins.forget(id, "floor", "office")
                        origins.keep(setOf("office"))
                    }
                }
            }
            tasks.forEach { it.get(10, TimeUnit.SECONDS) }
            assertEquals(0, origins.size)
        } finally {
            executor.shutdownNow()
        }
    }

    @Test
    fun providerReadStopsAtTheCapPlusOneWithoutTrustingMetadata() {
        var read = 0
        val endless = object : InputStream() {
            override fun read(): Int {
                read++
                check(read <= 33) { "Read past the overflow probe" }
                return 7
            }
        }
        assertNull(PictureLimits.read(endless, 32))
        assertEquals(33, read)
        val exact = ByteArray(32) { it.toByte() }
        assertArrayEquals(exact, PictureLimits.read(ByteArrayInputStream(exact), 32))
        assertArrayEquals(byteArrayOf(1, 2), PictureLimits.read(ByteArrayInputStream(byteArrayOf(1, 2)), 32))
        assertArrayEquals(byteArrayOf(), PictureLimits.read(ByteArrayInputStream(byteArrayOf()), 0))
    }

    @Test
    fun decodeDimensionsStayBoundedAndNeverRoundToZero() {
        assertEquals(2560 to 1, PictureLimits.size(Int.MAX_VALUE, 1, 2560))
        assertEquals(1 to 160, PictureLimits.size(1, Int.MAX_VALUE, 160))
        assertEquals(2560 to 1280, PictureLimits.size(5120, 2560, 2560))
        assertEquals(80 to 40, PictureLimits.size(80, 40, 160))
    }

    @Test
    fun keyboardInsetsOverlapBarsAndKeepCutoutSides() {
        val bars = WorkspaceInsets(10, 24, 8, 32)
        assertEquals(bars, bars.withKeyboard(0))
        assertEquals(bars, bars.withKeyboard(20))
        assertEquals(WorkspaceInsets(10, 24, 8, 300), bars.withKeyboard(300))
    }
}
