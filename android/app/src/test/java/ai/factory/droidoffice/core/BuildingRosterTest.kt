package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BuildingRosterTest {
    private val floorOffice = FloorInfo(id = "office", name = "droid-office", repo = "nikships/droid-office", dir = "/repos/droid-office", branch = "main")
    private val floorApi = FloorInfo(id = "api", name = "api-service", repo = "nikships/api-service", dir = "/repos/api-service", branch = "main")
    private val floorHome = FloorInfo(id = "home", name = "Home", home = true, plain = true, dir = "/Users/nik")
    private val floorNotes = FloorInfo(id = "notes", name = "Notes", plain = true, dir = "/Users/nik/notes")

    @Test
    fun repoLabelsDistinguishGitReposHomeAndPlainFolders() {
        assertEquals("nikships/droid-office", BuildingRoster.repoLabel(floorOffice))
        assertEquals("Home", BuildingRoster.repoLabel(floorHome))
        assertEquals("Folder", BuildingRoster.repoLabel(floorNotes))
        assertEquals("checkout-dir", BuildingRoster.repoLabel(FloorInfo(id = "x", name = "My App", dir = "/work/checkout-dir")))
        assertNull(BuildingRoster.repoLabel(FloorInfo(id = "x", name = "same", dir = "/work/same")))
    }

    @Test
    fun whereLabelIncludesFloorRepoAndBranchForCrossFloorAsks() {
        val w = WorkerInfo(id = "w1", name = "Atlas", worktree = WorktreeRef(branch = "feat/workers-tab"))
        assertEquals("droid-office · nikships/droid-office · feat/workers-tab", BuildingRoster.whereLabel(w, floorOffice))
        assertEquals("Mission Control", BuildingRoster.whereLabel(WorkerInfo(id = ORCHESTRATOR_ID, name = ORCHESTRATOR_NAME), floorOffice))
    }

    @Test
    fun arrangesAllFloorsWithUrgentSubagentsLiftingTheirCrossFloorLead() {
        val lead = WorkerInfo(id = "lead-1", name = "Grokbot", status = "working", createdAt = 10, deskId = "desk-1")
        val sub = WorkerInfo(
            id = "sub-1",
            name = "Pixel",
            status = "needs_input",
            waitingSince = 500L,
            lead = "lead-1",
            createdAt = 20,
            deskId = "desk-2",
            worktree = WorktreeRef(branch = "office/pixel"),
            ask = WorkerAsk(kind = "question", questions = listOf(AskedQuestion(question = "Ship Workers tab?", options = listOf("Yes", "No")))),
        )
        val other = WorkerInfo(id = "w-2", name = "Nova", status = "working", createdAt = 5, deskId = "desk-1")

        val mission = MissionControlState(
            orchestrator = OrchestratorState(settings = OrchestratorSettings(on = true)),
        )

        val view = BuildingRoster.build(
            floors = listOf(floorOffice, floorApi),
            workersByFloor = mapOf(
                "office" to listOf(lead),
                "api" to listOf(sub, other),
            ),
            pullsByFloor = mapOf(
                "api" to listOf(GhPull(number = 42, state = "OPEN", headRefName = "office/pixel", url = "https://github.com/nikships/api-service/pull/42")),
            ),
            mission = mission,
            screens = emptyMap(),
        )

        assertEquals(1, view.totalSummary.waiting)
        assertEquals(2, view.totalSummary.working)
        assertEquals(1, view.asks.size)
        assertEquals("sub-1", view.asks.single().worker.id)

        // Lead + urgent cross-floor subagent group rises above Nova (working) and idle Orchestrator.
        assertEquals(listOf("lead-1", "sub-1", "w-2", ORCHESTRATOR_ID), view.rows.map { it.worker.id })
        val subRow = view.rows[1]
        assertEquals(1, subRow.depth)
        assertEquals("Grokbot", subRow.leadName)
        assertTrue(subRow.crossFloorLead)
        assertEquals("api", subRow.floorId)
        assertEquals(42, Workers.pr(subRow.worker, subRow.pulls)?.second?.number)
    }

    @Test
    fun nestedGrandchildrenAndLeadCyclesNeverDropWorkers() {
        val root = WorkerInfo(id = "root", name = "OrchestratorLead", status = "idle", createdAt = 1)
        val child = WorkerInfo(id = "child", name = "Coordinator", status = "working", lead = "root", createdAt = 2)
        val grandchild = WorkerInfo(id = "grand", name = "Scout", status = "needs_input", waitingSince = 50L, lead = "child", createdAt = 3)
        val cycA = WorkerInfo(id = "cyc-a", name = "Alpha", status = "working", lead = "cyc-b", createdAt = 4)
        val cycB = WorkerInfo(id = "cyc-b", name = "Beta", status = "working", lead = "cyc-a", createdAt = 5)

        val view = BuildingRoster.build(
            floors = listOf(floorOffice, floorApi),
            workersByFloor = mapOf(
                "office" to listOf(root, cycA),
                "api" to listOf(child, grandchild, cycB),
            ),
            pullsByFloor = emptyMap(),
            mission = null,
            screens = emptyMap(),
        )

        assertEquals(listOf("root", "child", "grand", "cyc-a", "cyc-b"), view.rows.map { it.worker.id })
        assertEquals(listOf(0, 1, 2, 0, 1), view.rows.map { it.depth })
    }
}
