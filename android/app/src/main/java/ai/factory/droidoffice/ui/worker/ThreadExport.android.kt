package ai.factory.droidoffice.ui.worker

import android.content.ClipData
import android.content.Context
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.FileProvider
import ai.factory.droidoffice.ui.LocalSnackbar
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/** Save the exact source bytes, not the downsampled preview. Capture the picture when Save is tapped. */
@Composable
internal fun rememberThreadDownload(name: String, type: String, load: suspend () -> ByteArray?): () -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = LocalSnackbar.current
    var pending by remember { mutableStateOf<(suspend () -> ByteArray?)?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(type)) { uri ->
        val selected = pending
        pending = null
        if (uri != null && selected != null) scope.launch {
            val saved = try {
                withContext(Dispatchers.IO) {
                    val bytes = selected() ?: error("Picture unavailable")
                    requireNotNull(context.contentResolver.openOutputStream(uri)).use { it.write(bytes) }
                }
                true
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                false
            }
            snackbar.showSnackbar(if (saved) "Saved" else "Couldn't save this file")
        }
    }
    return {
        pending = load
        launcher.launch(name)
    }
}

/** Share a real SVG attachment with a temporary read grant, never its markup as a text message. */
@Composable
internal fun rememberSvgShare(): suspend (String) -> Unit {
    val context = LocalContext.current
    return { svg -> shareThreadSvg(context, svg) }
}

private suspend fun shareThreadSvg(context: Context, svg: String) {
    val uri = withContext(Dispatchers.IO) {
        val dir = File(context.cacheDir, "thread-exports").apply { mkdirs() }
        val file = File.createTempFile("diagram-", ".svg", dir)
        file.writeText(svg)
        FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
    }
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "image/svg+xml"
        putExtra(Intent.EXTRA_STREAM, uri)
        clipData = ClipData.newRawUri("Mermaid diagram", uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(Intent.createChooser(send, "Share SVG"))
}
