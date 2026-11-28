package ai.factory.droidoffice.core

import ai.factory.droidoffice.core.WorkspaceMention.Item
import ai.factory.droidoffice.core.WorkspaceMention.Kind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors tests/thread-composer-mention.test.ts, so the phone's composer reads `@` as the web's does. */
class WorkspaceMentionTest {
    @Test
    fun findsATokenAtTheStartOrAfterWhitespace() {
        assertEquals(WorkspaceMention.Query(0, 1, ""), WorkspaceMention.find("@", 1))
        assertEquals(WorkspaceMention.Query(0, 14, "src/client/ui"), WorkspaceMention.find("@src/client/ui", 14))
        assertEquals(WorkspaceMention.Query(6, 27, "src/client"), WorkspaceMention.find("Check @src/client/style.css please", 17))
        assertEquals(WorkspaceMention.Query(6, 19, "package.json"), WorkspaceMention.find("line1\n@package.json", 19))
    }

    @Test
    fun ignoresEmailsDoubleAtAndCursorsOutsideAToken() {
        assertNull(WorkspaceMention.find("@src/foo.ts", 0))
        assertNull(WorkspaceMention.find("@src/foo.ts ", 12))
        assertNull(WorkspaceMention.find("", 0))
        assertNull(WorkspaceMention.find("Email nik@factory.ai", 20))
        assertNull(WorkspaceMention.find("foo@bar", 7))
        assertNull(WorkspaceMention.find("@@double", 8))
        assertNull(WorkspaceMention.find("(@paren", 7))
    }

    private val dirs = listOf("src/", "src/client/", "src/client/ui/", "tests/")
    private val files = listOf(
        "AGENTS.md", "package.json", "src/client/style.css", "src/client/team-thread.ts",
        "src/client/ui/worker-thread.ts", "src/client/ui/thread-mention.ts", "tests/team-thread.test.ts",
    )

    @Test
    fun bareAtListsTopLevelFoldersThenRootFiles() {
        assertEquals(
            listOf(Item("src/", Kind.Dir), Item("tests/", Kind.Dir), Item("AGENTS.md", Kind.File), Item("package.json", Kind.File)),
            WorkspaceMention.rank(files, dirs, "", 6).take(4),
        )
    }

    @Test
    fun aTrailingSlashDrillsIntoThatFolder() {
        val hits = WorkspaceMention.rank(files, dirs, "src/client/", 10)
        assertEquals("src/client/ui/", hits[0].path)
        assertEquals("src/client/style.css", hits[1].path)
        assertEquals("src/client/team-thread.ts", hits[2].path)
        assertTrue(hits.all { it.path.startsWith("src/client/") && it.path != "src/client/" })
    }

    @Test
    fun ranksExactBasenamesAndFuzzySubsequences() {
        assertEquals("src/client/style.css", WorkspaceMention.rank(files, dirs, "style.css")[0].path)
        assertTrue(WorkspaceMention.rank(files, dirs, "wt.ts").any { it.path == "src/client/ui/worker-thread.ts" })
        assertEquals(emptyList<Item>(), WorkspaceMention.rank(emptyList(), emptyList(), "anything"))
        assertEquals(WorkspaceMention.DEFAULT_LIMIT, WorkspaceMention.rank((1..40).map { "src/f$it.ts" }, emptyList(), "f").size)
    }

    @Test
    fun pickingAFolderKeepsNarrowingAndAFileEndsTheMention() {
        val dir = WorkspaceMention.apply("Inspect @cl", 8, 11, "src/client/")
        assertEquals(WorkspaceMention.Applied("Inspect @src/client/", 20), dir)
        assertEquals(WorkspaceMention.Query(8, 20, "src/client/"), WorkspaceMention.find(dir.value, dir.cursor))

        val file = WorkspaceMention.apply(dir.value, 8, 20, "src/client/style.css")
        assertEquals(WorkspaceMention.Applied("Inspect @src/client/style.css ", 30), file)
        assertNull(WorkspaceMention.find(file.value, file.cursor))

        assertEquals(WorkspaceMention.Applied("Check @package.json before shipping", 20), WorkspaceMention.apply("Check @pkg before shipping", 6, 10, "package.json"))
    }
}
