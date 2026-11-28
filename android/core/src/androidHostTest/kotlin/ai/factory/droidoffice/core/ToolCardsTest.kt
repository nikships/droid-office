package ai.factory.droidoffice.core

import ai.factory.droidoffice.core.ToolCards.DiffRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolCardsTest {
    private fun ctx(old: Int, new: Int, text: String = "line $new") = ThreadDiffLine(DiffLineKind.Ctx, text, old, new)
    private fun add(new: Int, text: String = "added $new") = ThreadDiffLine(DiffLineKind.Add, text, null, new)
    private fun del(old: Int, text: String = "removed $old") = ThreadDiffLine(DiffLineKind.Del, text, old, null)
    private fun hunk(text: String) = ThreadDiffLine(DiffLineKind.Hunk, text)

    private fun shape(rows: List<DiffRow>): String = rows.joinToString(" ") {
        when (it) {
            is DiffRow.Line -> when (it.line.kind) {
                DiffLineKind.Add -> "+${it.line.newLine}"
                DiffLineKind.Del -> "-${it.line.oldLine}"
                DiffLineKind.Ctx -> "=${it.line.newLine}"
                else -> "?"
            }
            is DiffRow.Hidden -> "[${it.count}]"
        }
    }

    @Test
    fun changeLabelsCountEveryChangedLineAsTheAppDoes() {
        assertEquals("Edit 12 lines", ToolCards.changeLabel(FileChangeKind.Modified, 8, 4))
        assertEquals("Write 1 line", ToolCards.changeLabel(FileChangeKind.Added, 1, 0))
        assertEquals("Delete 3 lines", ToolCards.changeLabel(FileChangeKind.Deleted, 0, 3))
        assertEquals("Edit file", ToolCards.changeLabel(FileChangeKind.Modified, 0, 0))
        assertEquals("Error writing file", ToolCards.changeError(FileChangeKind.Added))
    }

    @Test
    fun commandsAreTitledByTheirSummaryOrRunCommand() {
        assertEquals("Run the unit tests", ToolCards.commandTitle("run the unit tests"))
        assertEquals("Run command", ToolCards.commandTitle("  "))
        assertEquals("Run command", ToolCards.commandTitle(null))
        assertEquals("$ npm test\nok", ToolCards.commandCopy("npm test", "ok"))
        assertEquals("$ ls", ToolCards.commandCopy("ls", null))
    }

    @Test
    fun liveToolsMatchTheirEntryAndExposeOutputAndPermissionState() {
        val tools = listOf(
            ThreadLive.Tool(null, "Execute", 1, "running"),
            ThreadLive.Tool("tool-1", "Execute", 12, "waiting_permission", output = "building", more = 42),
        )
        assertEquals(null, ToolCards.live(tools, "missing"))
        assertEquals(ToolCards.Live(12, "building", 42, waitingPermission = true), ToolCards.live(tools, "tool-1"))
    }

    @Test
    fun outputDropsTerminalEscapesAndTrailingBlanksAndDimsPromptLines() {
        val lines = ToolCards.outputLines("\u001B[32mok\u001B[0m 3 tests\n\n$ next\r\nloading\rdone\n\n\n")
        assertEquals(listOf("ok 3 tests", "", "$ next", "done"), lines.map { it.text })
        assertEquals(listOf(false, true, true, false), lines.map { it.dim })
        assertEquals(emptyList<ToolCards.OutLine>(), ToolCards.outputLines(" \r\n\t\n"))
        assertEquals(listOf(ToolCards.OutLine("", true), ToolCards.OutLine("  $ next", true)), ToolCards.outputLines("\n  $ next\n \n"))
    }

    @Test
    fun aDiffKeepsOneContextLineAroundEachChangeAndFoldsTheRest() {
        val lines = listOf(hunk("@@ -10,7 +10,7 @@"), ctx(10, 10), ctx(11, 11), ctx(12, 12), del(13), add(13), ctx(14, 14), ctx(15, 15), ctx(16, 16))
        // Nine lines above the hunk, two context lines before the change and two after it fold away.
        assertEquals("[11] =12 -13 +13 =14 [2]", shape(ToolCards.diffRows(lines)))
    }

    @Test
    fun emptyHunksDoNotChangeDiffRowsOrHiddenLineKeys() {
        val lines = listOf(ctx(1, 1), ctx(2, 2), add(3), ctx(3, 4))
        val split = listOf(hunk("empty"), hunk("first")) + lines.take(3) +
            listOf(hunk("empty"), hunk("next")) + lines.drop(3) + hunk("trailing")
        assertEquals(ToolCards.diffRows(lines), ToolCards.diffRows(split))
        assertTrue(ToolCards.diffRows(listOf(hunk("empty"), hunk("empty"))).isEmpty())
    }

    @Test
    fun changesCloseTogetherKeepTheContextBetweenThem() {
        val lines = listOf(hunk("@@ -1,6 +1,6 @@"), ctx(1, 1), add(2), ctx(2, 3), ctx(3, 4), add(5), ctx(4, 6))
        assertEquals("=1 +2 =3 =4 +5 =6", shape(ToolCards.diffRows(lines)))
    }

    @Test
    fun theGapBetweenHunksCountsTheFileLinesThatWereNeverSent() {
        val lines = listOf(
            hunk("@@ -1,3 +1,3 @@"), ctx(1, 1), add(2), ctx(2, 3),
            hunk("@@ -40,3 +40,3 @@"), ctx(39, 40), del(40), ctx(41, 41),
        )
        val rows = ToolCards.diffRows(lines)
        assertEquals("=1 +2 =3 [36] =40 -40 =41", shape(rows))
        val gap = rows.filterIsInstance<DiffRow.Hidden>().single()
        assertTrue("a gap between hunks has nothing to open in place", gap.lines.isEmpty())
    }

    @Test
    fun hiddenContextCarriesItsLinesSoItCanOpenInPlace() {
        val lines = listOf(ctx(1, 1), ctx(2, 2), ctx(3, 3), ctx(4, 4), add(5), ctx(5, 6))
        val rows = ToolCards.diffRows(lines)
        assertEquals("[3] =4 +5 =6", shape(rows))
        val hidden = rows.first() as DiffRow.Hidden
        assertEquals(listOf(1, 2, 3), hidden.lines.map { it.newLine })
        assertEquals(1, hidden.startLine)
    }

    @Test
    fun blankEdgeContextIsTrimmedLikeTheApp() {
        val lines = listOf(ctx(1, 1, ""), add(2), ctx(2, 3, "  "))
        assertEquals("[1] +2 [1]", shape(ToolCards.diffRows(lines)))
    }

    @Test
    fun anUnnumberedEditStillFoldsItsContext() {
        val lines = listOf(
            ThreadDiffLine(DiffLineKind.Ctx, "a"), ThreadDiffLine(DiffLineKind.Ctx, "b"), ThreadDiffLine(DiffLineKind.Ctx, "c"),
            ThreadDiffLine(DiffLineKind.Add, "d"), ThreadDiffLine(DiffLineKind.Ctx, "e"),
        )
        val rows = ToolCards.diffRows(lines)
        assertEquals(2, (rows.first() as DiffRow.Hidden).count)
        assertEquals(listOf("c", "d", "e"), rows.drop(1).map { (it as DiffRow.Line).line.text })
    }

    @Test
    fun aCollapsedPlanShowsTheStepsInProgressElseTheNextOne() {
        val done = PlanStep(done = true, active = false, text = "a")
        val now = PlanStep(done = false, active = true, text = "b")
        val next = PlanStep(done = false, active = false, text = "c")
        assertEquals(listOf(now), ToolCards.planShown(listOf(done, now, next), expanded = false))
        assertEquals(listOf(next), ToolCards.planShown(listOf(done, next), expanded = false))
        assertEquals(listOf(done, now, next), ToolCards.planShown(listOf(done, now, next), expanded = true))
        assertEquals("In progress", ToolCards.stepState(now))
    }

    @Test
    fun summariesSplitIntoTheirVerbAndWhatItActedOn() {
        assertEquals("Explored" to "4 files, 2 searches", ToolCards.splitSummary("Explored 4 files, 2 searches"))
        assertEquals("Thought" to "", ToolCards.splitSummary("Thought"))
    }

    @Test
    fun activitiesReadTheOfficesSegmentsAndRowWords() {
        val row = ThreadPresentation.row(
            OfficeJson.parseToJsonElement(
                """
                {"kind":"activity","id":"activity:t1","from":1,"to":3,"sourceIds":["t1","t2"],"label":"x","state":"complete","live":false,"open":false,
                 "blocks":[{"kind":"tools","id":"tools:t1","label":"x","state":"complete","live":false,"open":false,
                   "actions":[{"id":"t1","title":"Read a.ts","category":"read","state":"complete","status":"","result":"Result","icon":"read","verb":"Read","subject":"src/a.ts"},
                              {"id":"t2","title":"Ran","category":"command","state":"failed","status":"","result":"Error","card":"command","icon":"terminal","verb":"","subject":"npm test","failedLabel":"Command failed"}]}],
                 "segments":[{"kind":"explore","id":"explore:t1","blockIds":["tools:t1"],"actionIds":["t1"],"action":"Explored","details":"1 file","live":false,"open":false},
                             {"kind":"tool","blockId":"tools:t1","actionId":"t2"},
                             {"kind":"repeat","id":"repeat:t2","actionIds":["t2"],"summaries":["Build","Test"],"times":2,"live":true,"open":true},
                             {"kind":"tasks","id":"tasks:t9","actionIds":["t9"],"label":"Ran 5 subagents","settled":5,"failed":1,"live":false,"open":true},
                             {"kind":"thought","blockId":"thought:t0"},
                             {"kind":"later","id":"z"}]}
                """.trimIndent(),
            ),
        ) as ThreadRow.Activity
        assertEquals(listOf("explore:t1", "t2", "repeat:t2", "tasks:t9", "thought:t0"), row.segments.map { it.id })
        val explore = row.segments.first() as ThreadSegment.Explore
        assertEquals("Explored" to "1 file", explore.action to explore.details)
        val actions = (row.blocks.single() as ThreadBlock.Tools).actions
        assertEquals("Read" to "src/a.ts", ToolCards.words(actions[0]))
        assertEquals(ToolCards.Glyph.Read, ToolCards.glyph(actions[0]))
        assertEquals("Command failed", ToolCards.endLabel(actions[1]))
        assertEquals(1, (row.segments[3] as ThreadSegment.Tasks).failed)
    }

    @Test
    fun anOlderOfficesActionsFallBackToTheirTitleAndCategory() {
        val a = ThreadModelAction(id = "t", title = "Edited a.ts", detail = "src/a.ts", category = "edit", state = ActivityState.Cancelled, status = "cancelled", result = "Cancelled")
        assertEquals("Edited a.ts" to "src/a.ts", ToolCards.words(a))
        assertEquals(ToolCards.Glyph.Edit, ToolCards.glyph(a))
        assertEquals("interrupted", ToolCards.endLabel(a))
    }

    @Test
    fun everyActionCategoryHasAnIcon() {
        assertEquals(ToolCards.Glyph.Terminal, ToolCards.glyph("command"))
        assertEquals(ToolCards.Glyph.Bot, ToolCards.glyph("delegate"))
        assertEquals(ToolCards.Glyph.File, ToolCards.glyph("anything else"))
    }
}
