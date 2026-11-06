package ai.factory.droidoffice.core

import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch

/**
 * The other floors a Droid hired on [current] can work in too, each in a worktree of its own on the
 * same branch: any floor but its own that is a git checkout on a branch (the web's repoChoices).
 */
fun repoChoices(floors: List<FloorInfo>, current: String?): List<FloorInfo> =
    floors.filter { it.id != current && !it.branch.isNullOrBlank() && !it.plain }

/** Keep receiving shell results while a Droid's Open snackbar waits for an answer. */
suspend fun Flow<WorkerInfo>.collectHires(
    onShell: (WorkerInfo) -> Unit,
    onDroid: suspend (WorkerInfo) -> Unit,
) = coroutineScope {
    collect { worker ->
        if (worker.isShell) onShell(worker) else launch { onDroid(worker) }
    }
}
