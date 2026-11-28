package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ThreadTurnsTest {
    private fun user(id: String, seq: Long, text: String) = ThreadEntry(id, seq, ThreadRole.User, ThreadKind.Text, text)
    private fun droid(id: String, seq: Long, text: String) = ThreadEntry(id, seq, ThreadRole.Assistant, ThreadKind.Text, text)

    private val entries = listOf(
        droid("a0", 0, "Hello before any prompt"),
        user("u1", 1, "Fix the build"),
        droid("a1", 2, "Looking"),
        droid("a2", 3, "Fixed"),
        user("u2", 4, "  Thanks  "),
        user("u3", 5, "Fix the build"),
    )

    @Test
    fun turnsPairEachPromptWithItsReplies() {
        assertEquals(
            listOf(ThreadTurns.Turn("", listOf("Hello before any prompt")), ThreadTurns.Turn("Fix the build", listOf("Looking", "Fixed")), ThreadTurns.Turn("Thanks", emptyList()), ThreadTurns.Turn("Fix the build", emptyList())),
            ThreadTurns.turns(entries),
        )
    }

    @Test
    fun promptsAreNewestFirstAndOnce() {
        assertEquals(listOf("Fix the build", "Thanks"), ThreadTurns.prompts(entries))
        assertEquals(listOf("Fix the build"), ThreadTurns.prompts(entries, max = 1))
    }

    @Test
    fun copyChoicesMatchDroidsCopyMenu() {
        assertEquals("Looking\n\nFixed", ThreadTurns.copyText(entries, ThreadTurns.Copy.Reply))
        assertEquals("Fix the build", ThreadTurns.copyText(entries, ThreadTurns.Copy.Prompt))
        assertEquals("s1", ThreadTurns.copyText(entries, ThreadTurns.Copy.Session, sessionId = "s1"))
        assertNull(ThreadTurns.copyText(entries, ThreadTurns.Copy.Session))
        assertEquals("User: Thanks\n\nUser: Fix the build", ThreadTurns.copyText(entries, ThreadTurns.Copy.Turns, count = 2))
        assertEquals(
            "Droid: Hello before any prompt\n\nUser: Fix the build\n\nDroid: Looking\n\nDroid: Fixed\n\nUser: Thanks\n\nUser: Fix the build",
            ThreadTurns.copyText(entries, ThreadTurns.Copy.Transcript),
        )
        assertNull(ThreadTurns.copyText(emptyList(), ThreadTurns.Copy.Transcript))
    }

    private fun change(path: String, kind: FileChangeKind) = ThreadFileChange(path, path.substringAfterLast('/'), kind, 1, 0, false)
    private fun action(id: String, state: ActivityState, vararg changes: ThreadFileChange) =
        ThreadModelAction(id = id, title = id, category = "edit", state = state, status = "", result = "Result", changes = changes.toList())
    private fun activity(id: String, vararg actions: ThreadModelAction) = ThreadRow.Activity(
        id, 0, 0, listOf(id), "Worked", ActivityState.Complete, live = false,
        blocks = listOf(ThreadBlock.Tools("$id:b", "Edited", ActivityState.Complete, live = false, actions = actions.toList())),
    )
    private fun message(id: String) = ThreadRow.Message(id, 0, 0, ThreadRole.User, startsTurn = true)

    @Test
    fun rewindFilesAreTheChangesAfterTheMessage() {
        val rows = listOf(
            activity("x0", action("t0", ActivityState.Complete, change("src/early.ts", FileChangeKind.Modified))),
            message("u1"),
            activity(
                "x1",
                action("t1", ActivityState.Complete, change("src/new.ts", FileChangeKind.Added), change("src/a.ts", FileChangeKind.Modified)),
                action("t2", ActivityState.Failed, change("src/failed.ts", FileChangeKind.Modified)),
            ),
            message("u2"),
            activity("x2", action("t3", ActivityState.Complete, change("src/new.ts", FileChangeKind.Modified))),
        )
        assertEquals(
            listOf(ThreadTurns.RewindFile("src/new.ts", "new.ts", delete = true), ThreadTurns.RewindFile("src/a.ts", "a.ts", delete = false)),
            ThreadTurns.rewindFiles(rows, "u1"),
        )
        assertEquals(listOf(ThreadTurns.RewindFile("src/new.ts", "new.ts", delete = false)), ThreadTurns.rewindFiles(rows, "u2"))
        assertEquals(emptyList<ThreadTurns.RewindFile>(), ThreadTurns.rewindFiles(rows, "missing"))
    }
}
