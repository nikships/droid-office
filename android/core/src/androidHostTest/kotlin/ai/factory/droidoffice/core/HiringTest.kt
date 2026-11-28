package ai.factory.droidoffice.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class HiringTest {
    @Test
    fun aDroidSnackbarDoesNotDelayShellNavigation() = runTest {
        val hired = MutableSharedFlow<WorkerInfo>()
        val dismiss = CompletableDeferred<Unit>()
        val announced = mutableListOf<String>()
        val opened = mutableListOf<String>()
        val collector = backgroundScope.launch {
            hired.collectHires(
                onShell = { opened += it.id },
                onDroid = {
                    announced += it.id
                    dismiss.await()
                    opened += it.id
                },
            )
        }
        runCurrent()
        hired.emit(WorkerInfo(id = "droid", kind = "agent"))
        runCurrent()
        assertEquals(listOf("droid"), announced)
        hired.emit(WorkerInfo(id = "shell", kind = "shell"))
        runCurrent()
        assertFalse(dismiss.isCompleted)
        assertEquals(listOf("shell"), opened)
        dismiss.complete(Unit)
        runCurrent()
        assertEquals(listOf("shell", "droid"), opened)
        collector.cancel()
    }

    @Test
    fun leavingTheCollectorCancelsPendingSnackbars() = runTest {
        val hired = MutableSharedFlow<WorkerInfo>()
        val waiting = CompletableDeferred<Unit>()
        var cancelled = false
        val collector = backgroundScope.launch {
            hired.collectHires(
                onShell = { error("No shell hired") },
                onDroid = {
                    try {
                        waiting.await()
                    } finally {
                        cancelled = true
                    }
                },
            )
        }
        runCurrent()
        hired.emit(WorkerInfo(id = "droid", kind = "agent"))
        runCurrent()
        collector.cancel()
        runCurrent()
        assertTrue(cancelled)
    }
}
