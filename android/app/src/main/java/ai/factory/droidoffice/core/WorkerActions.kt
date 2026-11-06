package ai.factory.droidoffice.core

object WorkerActions {
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
