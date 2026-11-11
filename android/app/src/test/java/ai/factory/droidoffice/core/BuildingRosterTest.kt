package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
    fun filteringToSubagentFloorKeepsSubagentVisibleAtRootWithLeadAttribution() {
        val lead = WorkerInfo(id = "lead-1", name = "Grokbot", status = "working", deskId = "desk-1")
        val sub = WorkerInfo(id = "sub-1", name = "Pixel", status = "working", lead = "lead-1", deskId = "desk-2")

        val view = BuildingRoster.build(
            floors = listOf(floorOffice, floorApi),
            workersByFloor = mapOf("office" to listOf(lead), "api" to listOf(sub)),
            pullsByFloor = emptyMap(),
            mission = null,
            screens = emptyMap(),
            floorFilter = "api",
        )

        assertEquals(listOf("sub-1"), view.rows.map { it.worker.id })
        val row = view.rows.single()
        assertEquals(0, row.depth)
        assertEquals("Grokbot", row.leadName)
        assertEquals(2, view.floorCounts[BuildingRoster.ALL_FLOORS])
        assertEquals(1, view.floorCounts["office"])
        assertEquals(1, view.floorCounts["api"])
    }

    @Test
    fun multiTokenSearchMatchesAcrossRepoBranchModelPrAndQuestionText() {
        val w1 = WorkerInfo(
            id = "w-1",
            name = "Pixel",
            status = "needs_input",
            model = "custom:droidproxy:claude-opus-4-6",
            deskId = "desk-3",
            worktree = WorktreeRef(branch = "office/workers-tab"),
            repos = listOf(WorkerRepo(floor = "api", name = "api-service", repo = "nikships/api-service", branch = "office/workers-tab")),
            task = WorkerTask(name = "Build Workers Tab", summary = "Cross-floor search and filters"),
            ask = WorkerAsk(kind = "permission", tool = "Execute", command = "./gradlew testDebugUnitTest", risk = "medium"),
        )
        val w2 = WorkerInfo(id = "w-2", name = "Bolt", kind = "shell", status = "idle", deskId = "desk-4")
        val pulls = mapOf("office" to listOf(GhPull(number = 402, state = "OPEN", headRefName = "office/workers-tab")))

        fun search(q: String) = BuildingRoster.build(
            floors = listOf(floorOffice, floorApi),
            workersByFloor = mapOf("office" to listOf(w1), "api" to listOf(w2)),
            pullsByFloor = pulls,
            mission = null,
            screens = emptyMap(),
            query = q,
        ).rows.map { it.worker.id }

        assertEquals(listOf("w-1"), search("opus #402"))
        assertEquals(listOf("w-1"), search("api-service gradlew"))
        assertEquals(listOf("w-1"), search("nikships/droid-office workers-tab"))
        assertEquals(listOf("w-2"), search("shell desk 4"))
        assertTrue(search("nonexistent-token").isEmpty())
    }

    @Test
    fun statusChipsFilterBothRowsAndNeedsYouQueuePredictably() {
        val waiting = WorkerInfo(id = "w-wait", name = "Ada", status = "needs_input", waitingSince = 100L)
        val done = WorkerInfo(id = "w-done", name = "Grace", status = "done", acked = false, waitingSince = 200L)
        val asleep = WorkerInfo(id = "w-sleep", name = "Linus", status = "exited")

        val workingFilter = BuildingRoster.build(
            floors = listOf(floorOffice),
            workersByFloor = mapOf("office" to listOf(waiting, done, asleep)),
            pullsByFloor = emptyMap(),
            mission = null,
            screens = emptyMap(),
            statusFilter = RosterStatusFilter.Done,
        )

        assertFalse(workingFilter.asks.any())
        assertEquals(listOf("w-done"), workingFilter.rows.map { it.worker.id })
        assertEquals(1, workingFilter.statusCounts[RosterStatusFilter.NeedsInput])
        assertEquals(1, workingFilter.statusCounts[RosterStatusFilter.Done])
        assertEquals(1, workingFilter.statusCounts[RosterStatusFilter.Asleep])
        // Total waiting in the building stays visible for the header badge even while viewing Done.
        assertEquals(1, workingFilter.totalSummary.waiting)
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
