package ai.factory.droidoffice.core

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReceiptsTest {
    private fun dir(): File = Files.createTempDirectory("receipts").toFile().also { it.deleteOnExit() }

    private fun queue(vararg texts: String) = ThreadQueue().apply { texts.forEach { sent(it, hasImage = false, after = 4) } }

    @Test
    fun aSnapshotComesBackForItsKeyOnly() {
        val r = Receipts(dir())
        val q = queue("first", "second")
        assertEquals(Receipts.Saved.Kept, r.save("o/f/w", q.snapshot()))
        assertEquals(Receipts.Loaded.Found(q.snapshot()), r.load("o/f/w"))
        assertEquals(Receipts.Loaded.Found(null), r.load("o/f/other"))
        assertEquals(listOf("first", "second"), ThreadQueue((r.load("o/f/w") as Receipts.Loaded.Found).snapshot).pending.map { it.text })
    }

    @Test
    fun noReceiptsLeftRemovesTheFile() {
        val d = dir()
        val r = Receipts(d)
        r.save("o/f/w", queue("a").snapshot())
        assertEquals(Receipts.Saved.Removed, r.save("o/f/w", null))
        assertEquals(Receipts.Loaded.Found(null), r.load("o/f/w"))
        assertEquals(0, d.listFiles()!!.size)
    }

    @Test
    fun thirtyTwoLongMessagesFitAndAnythingLargerIsRefusedAndForgotten() {
        val r = Receipts(dir())
        val full = ThreadQueue().apply { repeat(32) { sent("m$it " + "x".repeat(19_990), hasImage = false, after = 1) } }
        val snapshot = full.snapshot()
        assertTrue(snapshot.length <= Receipts.MAX_CHARS)
        assertEquals(Receipts.Saved.Kept, r.save("o/f/w", snapshot))
        assertTrue(Receipts.restorable(full, snapshot))
        assertEquals(32, ThreadQueue((r.load("o/f/w") as Receipts.Loaded.Found).snapshot).pending.size)
        // Too large: refused, and the older copy goes too, so it can't come back stale.
        assertEquals(Receipts.Saved.TooLarge, r.save("o/f/w", "x".repeat(Receipts.MAX_CHARS + 1)))
        assertEquals(Receipts.Loaded.Found(null), r.load("o/f/w"))
    }

    @Test
    fun aMessageTheQueueCannotRestoreIsSaidToBeUnrestorable() {
        val q = queue("short", "y".repeat(20_001))
        assertFalse(Receipts.restorable(q, q.snapshot()))
        val ok = queue("short")
        assertTrue(Receipts.restorable(ok, ok.snapshot()))
    }

    @Test
    fun onlyTheMostRecentlyWrittenWorkersAreKept() {
        val d = dir()
        val r = Receipts(d)
        val q = queue("a").snapshot()
        // Write times a second apart, whatever the file system's clock resolution.
        val base = System.currentTimeMillis() - 100_000
        repeat(Receipts.MAX_WORKERS + 3) { i ->
            r.save("o/f/w$i", q)
            d.listFiles { f -> f.name.endsWith(".json") }!!.maxBy { it.lastModified() }.setLastModified(base + i * 1_000L)
        }
        assertEquals(Receipts.MAX_WORKERS, d.listFiles { f -> f.name.endsWith(".json") }!!.size)
        assertEquals(Receipts.Loaded.Found(null), r.load("o/f/w0"))
        assertEquals(Receipts.Loaded.Found(q), r.load("o/f/w${Receipts.MAX_WORKERS + 2}"))
    }

    @Test
    fun forgettingAnOfficeForgetsItsWorkersOnly() {
        val r = Receipts(dir())
        val q = queue("a").snapshot()
        r.save("o1/f/w", q)
        r.save("o1/g/v", q)
        r.save("o2/f/w", q)
        r.removeOffice("o1")
        assertEquals(Receipts.Loaded.Found(null), r.load("o1/f/w"))
        assertEquals(Receipts.Loaded.Found(null), r.load("o1/g/v"))
        assertEquals(Receipts.Loaded.Found(q), r.load("o2/f/w"))
    }

    @Test
    fun aDiskErrorIsReportedNotThrown() {
        val d = dir()
        // A file where the directory should be: nothing can be written under it.
        val blocked = File(d, "blocked").apply { writeText("") }
        val r = Receipts(blocked)
        assertEquals(Receipts.Saved.Failed, r.save("o/f/w", queue("a").snapshot()))
        assertEquals(Receipts.Loaded.Found(null), r.load("o/f/w"))
        val unreadable = Receipts(d)
        unreadable.save("o/f/w", queue("a").snapshot())
        d.listFiles { f -> f.name.endsWith(".json") }!!.single().let { it.delete(); it.mkdir() }
        assertTrue(unreadable.load("o/f/w") is Receipts.Loaded.Failed)
    }

    @Test
    fun receiptsMadeBeforeTheDiskAnsweredJoinWhatItHeld() {
        val loaded = ThreadQueue(queue("from disk").snapshot())
        val early = queue("typed early")
        val merged = Receipts.merge(loaded, early)
        assertEquals(listOf("from disk", "typed early"), merged.pending.map { it.text })
        assertEquals(listOf(4L, 4L), merged.pending.map { it.after })
    }
}
