package ai.factory.droidoffice.core

import java.io.File
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateControllerTest {
    private val release = AppRelease("0.1.10", 10, UpdateApk("unused", 100, "a".repeat(64)))
    private val file = File("verified.apk")

    private class Source(var found: AppRelease?) : UpdateSource {
        var checks = 0
        var downloads = 0
        var error: Exception? = null
        var wait: CompletableDeferred<Unit>? = null
        var downloading: CompletableDeferred<Unit>? = null
        override suspend fun latest(): AppRelease? {
            checks++
            wait?.await()
            error?.let { throw it }
            return found
        }
        override suspend fun download(release: AppRelease, progress: (Long) -> Unit): File {
            downloads++
            downloading?.complete(Unit)
            if (downloading != null) awaitCancellation()
            progress(50)
            error?.let { throw it }
            progress(100)
            return File("verified.apk")
        }
    }

    @Test fun checksAreQuietAndDoNotAutomaticallyDownload() = runTest {
        val source = Source(release)
        val updates = UpdateController(this, source)
        updates.check()
        assertTrue(updates.state.value.busy)
        testScheduler.runCurrent()
        assertEquals(release, updates.state.value.release)
        assertTrue(updates.state.value.checked)
        assertEquals(0, source.downloads)
    }

    @Test fun noNewerReleaseMeansUpToDate() = runTest {
        val updates = UpdateController(this, Source(null))
        updates.check()
        testScheduler.runCurrent()
        assertTrue(updates.state.value.checked)
        assertNull(updates.state.value.release)
        assertNull(updates.state.value.error)
    }

    @Test fun successIsThrottledForAnHourButManualCheckBypassesIt() = runTest {
        var clock = 1L
        val source = Source(null)
        val updates = UpdateController(this, source) { clock }
        updates.check()
        testScheduler.runCurrent()
        updates.check()
        testScheduler.runCurrent()
        assertEquals(1, source.checks)
        updates.check(force = true)
        testScheduler.runCurrent()
        assertEquals(2, source.checks)
        clock += 60 * 60_000
        updates.check()
        testScheduler.runCurrent()
        assertEquals(3, source.checks)
    }

    @Test fun failureIsNotUpToDateAndRetriesAfterFifteenMinutes() = runTest {
        var clock = 1L
        val source = Source(null).apply { error = IOException("offline") }
        val updates = UpdateController(this, source) { clock }
        updates.check()
        testScheduler.runCurrent()
        assertFalse(updates.state.value.checked)
        assertNotNull(updates.state.value.error)
        updates.check()
        testScheduler.runCurrent()
        assertEquals(1, source.checks)
        clock += 15 * 60_000
        source.error = null
        updates.check()
        testScheduler.runCurrent()
        assertTrue(updates.state.value.checked)
        assertNull(updates.state.value.error)
    }

    @Test fun failedRefreshKeepsAKnownAvailableUpdate() = runTest {
        val source = Source(release)
        val updates = UpdateController(this, source)
        updates.check()
        testScheduler.runCurrent()
        source.error = IOException("rate limited")
        updates.check(force = true)
        testScheduler.runCurrent()
        assertEquals(release, updates.state.value.release)
        assertNotNull(updates.state.value.error)
    }

    @Test fun concurrentChecksAreCoalesced() = runTest {
        val source = Source(release).apply { wait = CompletableDeferred() }
        val updates = UpdateController(this, source)
        updates.check()
        updates.check(force = true)
        updates.download()
        testScheduler.runCurrent()
        assertEquals(1, source.checks)
        assertEquals(0, source.downloads)
        source.wait!!.complete(Unit)
        testScheduler.runCurrent()
    }

    @Test fun explicitDownloadBecomesReadyAndCheckCannotReplaceIt() = runTest {
        val source = Source(release)
        val updates = UpdateController(this, source)
        updates.check()
        testScheduler.runCurrent()
        updates.download()
        assertEquals(UpdatePhase.Downloading, updates.state.value.phase)
        updates.download()
        updates.check(force = true)
        testScheduler.runCurrent()
        assertEquals(UpdatePhase.Ready, updates.state.value.phase)
        assertEquals(file, updates.state.value.file)
        assertEquals(100L, updates.state.value.bytes)
        assertEquals(1, source.downloads)
        updates.check(force = true)
        testScheduler.runCurrent()
        assertEquals(1, source.checks)
    }

    @Test fun downloadFailureKeepsRetryAndBrowserFallbackAvailable() = runTest {
        val source = Source(release)
        val updates = UpdateController(this, source)
        updates.check()
        testScheduler.runCurrent()
        source.error = IOException("The update download couldn't be verified. Try again.")
        updates.download()
        testScheduler.runCurrent()
        assertEquals(UpdatePhase.Idle, updates.state.value.phase)
        assertNull(updates.state.value.file)
        assertEquals(release, updates.state.value.release)
        assertEquals(source.error!!.message, updates.state.value.error)
        source.error = IOException()
        updates.download()
        testScheduler.runCurrent()
        assertEquals("Couldn't download the update. Try again.", updates.state.value.error)
        source.error = null
        updates.download()
        testScheduler.runCurrent()
        assertEquals(UpdatePhase.Ready, updates.state.value.phase)
    }

    @Test fun cancelDownloadDoesNotTurnCancellationIntoAnError() = runTest {
        val source = Source(release).apply { downloading = CompletableDeferred() }
        val updates = UpdateController(this, source)
        updates.check()
        testScheduler.runCurrent()
        updates.download()
        testScheduler.runCurrent()
        source.downloading!!.await()
        updates.cancelDownload()
        testScheduler.runCurrent()
        assertEquals(UpdatePhase.Idle, updates.state.value.phase)
        assertNull(updates.state.value.error)
        assertNull(updates.state.value.file)
        source.downloading = null
        updates.download()
        testScheduler.runCurrent()
        assertEquals(UpdatePhase.Ready, updates.state.value.phase)
    }

    @Test fun browserOnlyReleasesCannotStartADownload() = runTest {
        val source = Source(release.copy(apk = null))
        val updates = UpdateController(this, source)
        updates.check()
        testScheduler.runCurrent()
        updates.download()
        testScheduler.runCurrent()
        assertEquals(0, source.downloads)
    }

    @Test fun immediateRetryWaitsForCancelledDownloadsCleanup() = runTest {
        var downloads = 0
        val source = object : UpdateSource {
            override suspend fun latest() = release
            override suspend fun download(release: AppRelease, progress: (Long) -> Unit): File {
                downloads++
                if (downloads == 1) try {
                    awaitCancellation()
                } finally {
                    withContext(NonCancellable) { delay(1_000) }
                }
                return file
            }
        }
        val updates = UpdateController(this, source)
        updates.check()
        testScheduler.runCurrent()
        updates.download()
        testScheduler.runCurrent()
        updates.cancelDownload()
        updates.download()
        testScheduler.runCurrent()
        assertEquals(1, downloads)
        testScheduler.advanceUntilIdle()
        assertEquals(2, downloads)
        assertEquals(UpdatePhase.Ready, updates.state.value.phase)
    }

    @Test fun installerFailureKeepsTheVerifiedApkForRetry() = runTest {
        val updates = UpdateController(this, Source(release))
        updates.check()
        testScheduler.runCurrent()
        updates.download()
        testScheduler.runCurrent()
        updates.installFailed("Couldn't open Android's installer.")
        assertEquals(UpdatePhase.Ready, updates.state.value.phase)
        assertEquals(file, updates.state.value.file)
        assertNotNull(updates.state.value.error)
        updates.clearError()
        assertNull(updates.state.value.error)
        assertEquals(UpdatePhase.Ready, updates.state.value.phase)
    }
}
