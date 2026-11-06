package ai.factory.droidoffice.core

import kotlinx.coroutines.CancellationException

object WorkerActions {
    /** An uncertain send is never replayed. Always release the dialog, even on cancellation. */
    suspend fun confirm(onFinished: () -> Unit, send: suspend () -> ServerMsg.ActionResult?): ServerMsg.ActionResult? = try {
        send()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        null
    } finally {
        onFinished()
    }

    /** Mirrors src/shared/worker-fork.ts; capacity and filesystem checks stay with the office. */
    fun forkRefusal(w: WorkerInfo): String? = when {
        w.kind != "agent" || w.remote -> "Only local Droid workers can be forked"
        w.lost != null -> "Restore its missing worktree before forking"
        w.sessionId.isNullOrBlank() -> "Wait for its Droid session to start before forking"
        w.state != WorkerStatus.Idle && w.state != WorkerStatus.Done -> "Wait until its turn ends before forking"
        w.prOpening -> "Wait for its pull request to finish opening"
        else -> null
    }
}
