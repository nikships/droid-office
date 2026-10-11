package ai.factory.droidoffice.core

import java.io.File
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class UpdatePhase { Idle, Checking, Downloading, Ready }

data class UpdateState(
    val phase: UpdatePhase = UpdatePhase.Idle,
    val release: AppRelease? = null,
    val checked: Boolean = false,
    val bytes: Long = 0,
    val file: File? = null,
    val error: String? = null,
) {
    val busy get() = phase == UpdatePhase.Checking || phase == UpdatePhase.Downloading
}

/** One update at a time, owned by the app rather than a screen or activity. */
class UpdateController(
    private val scope: CoroutineScope,
    private val source: UpdateSource,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val mutable = MutableStateFlow(UpdateState())
    val state = mutable.asStateFlow()
    private var job: Job? = null
    private var nextCheck = 0L

    fun check(force: Boolean = false) {
        if (state.value.busy || state.value.phase == UpdatePhase.Ready || (!force && now() < nextCheck)) return
        val previous = job
        nextCheck = now() + 15 * 60_000
        mutable.update { it.copy(phase = UpdatePhase.Checking, error = null) }
        job = scope.launch {
            previous?.join()
            try {
                val release = source.latest()
                mutable.value = UpdateState(release = release, checked = true)
                nextCheck = now() + 60 * 60_000
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                mutable.update { it.copy(phase = UpdatePhase.Idle, error = "Couldn't check for updates. Try again when you're online.") }
            }
        }
    }

    fun download() {
        val current = state.value
        val release = current.release ?: return
        if (current.busy || release.apk == null) return
        val previous = job
        mutable.update { it.copy(phase = UpdatePhase.Downloading, bytes = 0, file = null, error = null) }
        job = scope.launch {
            // A cancelled download must finish removing its .part file before a retry uses it.
            previous?.join()
            try {
                val file = source.download(release) { bytes -> mutable.update { it.copy(bytes = bytes) } }
                mutable.update { it.copy(phase = UpdatePhase.Ready, file = file) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                mutable.update {
                    it.copy(phase = UpdatePhase.Idle, file = null, error = (e as? IOException)?.message ?: "Couldn't download the update. Try again.")
                }
            }
        }
    }

    fun cancelDownload() {
        if (state.value.phase != UpdatePhase.Downloading) return
        job?.cancel()
        mutable.update { it.copy(phase = UpdatePhase.Idle, file = null, error = null, bytes = 0) }
    }

    fun installFailed(message: String) {
        mutable.update { it.copy(error = message) }
    }

    fun clearError() {
        mutable.update { it.copy(error = null) }
    }
}
