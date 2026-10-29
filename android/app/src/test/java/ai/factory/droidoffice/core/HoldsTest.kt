package ai.factory.droidoffice.core

import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HoldsTest {
    /** OfficeConnection's counting, as the tests need it. */
    private class Counter : SharedHolds {
        override fun <T> locked(action: () -> T): T = synchronized(this, action)
        var gen = 0L
        val counts = HashMap<String, Int>()
        val sent = ArrayList<String>()
        override fun generation(): Long {
            check(Thread.holdsLock(this))
            return gen
        }
        override fun attach(workerId: String) {
            check(Thread.holdsLock(this))
            counts[workerId] = (counts[workerId] ?: 0) + 1
            if (counts[workerId] == 1) sent += "attach:$workerId"
        }
        override fun detach(workerId: String) {
            check(Thread.holdsLock(this))
            check((counts[workerId] ?: 0) > 0)
            val n = (counts[workerId] ?: 1) - 1
            if (n <= 0) {
                counts.remove(workerId)
                sent += "detach:$workerId"
            } else counts[workerId] = n
        }
        override fun resnapshot(workerId: String) {
            check(Thread.holdsLock(this))
            sent += "snapshot:$workerId"
        }
        fun reset() = locked {
            counts.clear()
            gen++
        }
    }

    @Test
    fun concurrentOwnersAndOfficeResetsKeepGenerationAndCountsAtomic() {
        val c = Counter()
        val executor = Executors.newFixedThreadPool(5)
        try {
            val tasks = (1..4).map {
                executor.submit {
                    val tokens = HoldTokens(c)
                    val raw = OwnedHolds(c)
                    repeat(1_000) {
                        val token = tokens.hold("w1")
                        raw.attach("w1")
                        raw.attach("w1")
                        tokens.release(token)
                        raw.release()
                    }
                }
            } + executor.submit { repeat(1_000) { c.reset() } }
            tasks.forEach { it.get(10, TimeUnit.SECONDS) }
            assertTrue(c.counts.isEmpty())
        } finally {
            executor.shutdownNow()
        }
    }

    @Test
    fun aJoinNeverDetachesWhatAnotherViewHolds() {
        val c = Counter()
        val terminal = HoldTokens(c)
        val t = terminal.hold("w1")
        val page = OwnedHolds(c)
        page.attach("w1")
        assertTrue(page.detach("w1"))
        assertFalse(page.detach("w1"))
        assertEquals(1, c.counts["w1"])
        page.detach("w2")
        page.release()
        assertEquals(1, c.counts["w1"])
        terminal.release(t)
        terminal.release(t)
        assertEquals(listOf("attach:w1", "detach:w1"), c.sent)
    }

    @Test
    fun twoJoinsOnOneSocketReleaseOnlyTheirOwn() {
        val c = Counter()
        val a = OwnedHolds(c)
        val b = OwnedHolds(c)
        a.attach("w1")
        a.attach("w1")
        b.attach("w1")
        b.attach("w2")
        assertEquals(listOf("attach:w1", "snapshot:w1", "attach:w2"), c.sent)
        a.release()
        assertEquals(1, c.counts["w1"])
        assertEquals(setOf("w1", "w2"), b.workers)
        b.release()
        assertTrue(c.counts.isEmpty())
        assertTrue(b.workers.isEmpty())
    }

    @Test
    fun holdsFromBeforeAnOfficeSwitchAreNotReleasedTwice() {
        val c = Counter()
        val page = OwnedHolds(c)
        val tokens = HoldTokens(c)
        page.attach("w1")
        val t = tokens.hold("w1")
        c.reset()
        val fresh = tokens.hold("w1")
        page.release()
        tokens.release(t)
        assertEquals(1, c.counts["w1"])
        page.attach("w1")
        assertEquals(2, c.counts["w1"])
        tokens.releaseAll()
        page.release()
        assertTrue(c.counts.isEmpty())
        assertEquals(0, tokens.size)
        assertTrue(fresh > t)
    }
}
