package ai.factory.droidoffice.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import ai.factory.droidoffice.ui.components.statusLook

class WorkerActionsTest {
    private val ready = WorkerInfo(id = "source", kind = "agent", status = "idle", sessionId = "session")

    @Test
    fun confirmationAlwaysFinishesAndPreservesReceipts() = runBlocking {
        var finished = 0
        listOf(ServerMsg.ActionResult("fork", true, null), ServerMsg.ActionResult("dismiss", false, "Refused"), null).forEach { receipt ->
            assertEquals(receipt, WorkerActions.confirm(onFinished = { finished++ }) { receipt })
        }
        assertEquals(3, finished)
    }

    @Test
    fun failedSendIsUnconfirmedAndReleasesPendingWithoutRetrying() = runBlocking {
        var finished = false
        var sends = 0
        assertNull(WorkerActions.confirm(onFinished = { finished = true }) {
            sends++
            throw IllegalStateException("Socket closed")
        })
        assertTrue(finished)
        assertEquals(1, sends)
    }

    @Test
    fun cancelledConfirmationReleasesPendingAndStillCancels() = runBlocking {
        var finished = false
        var cancelled = false
        try {
            WorkerActions.confirm(onFinished = { finished = true }) { throw CancellationException("Left the floor") }
        } catch (_: CancellationException) {
            cancelled = true
        }
        assertTrue(cancelled)
        assertTrue(finished)
    }

    @Test
    fun onlyIdleOrDoneLocalDroidsWithASessionCanFork() {
        assertNull(WorkerActions.forkRefusal(ready))
        assertNull(WorkerActions.forkRefusal(ready.copy(status = "done", acked = false)))
        listOf("starting", "working", "needs_input", "exited", "offline", "unknown").forEach {
            assertEquals("Wait until its turn ends before forking", WorkerActions.forkRefusal(ready.copy(status = it)))
        }
        listOf("shell", "cloud", "other").forEach {
            assertEquals("Only local Droid workers can be forked", WorkerActions.forkRefusal(ready.copy(kind = it)))
        }
        assertEquals("Only local Droid workers can be forked", WorkerActions.forkRefusal(ready.copy(remote = true)))
    }

    @Test
    fun missingWorktreeSessionAndOpeningPullRequestExplainTheRefusal() {
        assertEquals("Restore its missing worktree before forking", WorkerActions.forkRefusal(ready.copy(lost = JsonObject(emptyMap()))))
        listOf(null, "", " ").forEach {
            assertEquals("Wait for its Droid session to start before forking", WorkerActions.forkRefusal(ready.copy(sessionId = it)))
        }
        assertEquals("Wait for its pull request to finish opening", WorkerActions.forkRefusal(ready.copy(prOpening = true)))
    }

    @Test
    fun forkCarriesTheClickedWorkerFloorReceiptAndOnlyAnExplicitDirection() {
        val blank = Json.parseToJsonElement(ClientMsg.fork("clicked", "  ", "once", "floor")).jsonObject
        assertEquals(setOf("t", "workerId", "requestId", "requestFloor"), blank.keys)
        assertEquals("worker.fork", blank.getValue("t").jsonPrimitive.content)
        assertEquals("clicked", blank.getValue("workerId").jsonPrimitive.content)
        assertEquals("floor", blank.getValue("requestFloor").jsonPrimitive.content)
        assertEquals("once", blank.getValue("requestId").jsonPrimitive.content)
        val direction = Json.parseToJsonElement(ClientMsg.fork("clicked", "  New direction\n  ", "two", null)).jsonObject
        assertEquals("New direction", direction.getValue("prompt").jsonPrimitive.content)
        assertFalse(direction.containsKey("requestFloor"))
    }

    @Test
    fun dismissKeepsSavedWorkAndCloudSessionsUnlessExplicitlySelected() {
        val keep = Json.parseToJsonElement(ClientMsg.kill("clicked", "keep", requestId = "once", floor = "floor")).jsonObject
        assertEquals("worker.kill", keep.getValue("t").jsonPrimitive.content)
        assertEquals("clicked", keep.getValue("workerId").jsonPrimitive.content)
        assertEquals("keep", keep.getValue("cleanup").jsonPrimitive.content)
        assertEquals("once", keep.getValue("requestId").jsonPrimitive.content)
        assertEquals("floor", keep.getValue("requestFloor").jsonPrimitive.content)
        assertFalse(keep.containsKey("deleteSession"))
        assertTrue(Json.parseToJsonElement(ClientMsg.kill("cloud", null, deleteSession = true)).jsonObject.containsKey("deleteSession"))
    }

    @Test
    fun actionReceiptsPreserveSuccessAndServerRefusals() {
        assertEquals(ServerMsg.ActionResult("fork", true, null), Protocol.decode("""{"t":"action.result","requestId":"fork","ok":true,"workerId":"twin"}"""))
        assertEquals(ServerMsg.ActionResult("dismiss", false, "The active floor changed. Nothing was sent."), Protocol.decode("""{"t":"action.result","requestId":"dismiss","ok":false,"error":"The active floor changed. Nothing was sent."}"""))
    }

    @Test
    fun compactIndicatorsKeepSpokenStatusesAndAttentionStatesDistinct() {
        assertEquals("Working", statusLook(WorkerStatus.Working).label)
        assertEquals("Done", statusLook(WorkerStatus.Done).label)
        assertEquals("Done · new", statusLook(WorkerStatus.Done, acked = false).label)
        assertEquals("Needs you", statusLook(WorkerStatus.NeedsInput).label)
        assertTrue(statusLook(WorkerStatus.NeedsInput).loud)
        assertEquals("Starting", statusLook(WorkerStatus.Starting).label)
        assertEquals("Ready", statusLook(WorkerStatus.Idle).label)
        assertEquals("Unknown", statusLook(WorkerStatus.Unknown).label)
        assertTrue(statusLook(WorkerStatus.Working).color != statusLook(WorkerStatus.Done).color)
    }
}
