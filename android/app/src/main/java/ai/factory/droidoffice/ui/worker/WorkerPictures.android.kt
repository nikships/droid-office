package ai.factory.droidoffice.ui.worker

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
internal fun rememberPicturePicker(limit: Int, selected: (List<PictureLoader>) -> Unit): () -> Unit {
    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(limit)) { uris ->
        selected(uris.map { uri -> suspend { withContext(Dispatchers.IO) { runCatching { load(context, uri) }.getOrNull() } } })
    }
    return { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
}

/** ImageDecoder applies EXIF orientation and samples before allocating the preview. */
internal suspend fun decodeScaled(bytes: ByteArray, side: Int): ImageBitmap? = withContext(Dispatchers.Default) {
    runCatching {
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) { d, info, _ ->
            var sample = 1
            while (maxOf(info.size.width, info.size.height) / (sample * 2) >= side) sample *= 2
            d.setTargetSampleSize(sample)
        }.asImageBitmap()
    }.getOrNull()
}

/** Keep the original when the office can take it; otherwise convert to JPEG. */
private fun load(context: Context, uri: Uri): Picture {
    val resolver = context.contentResolver
    val type = resolver.getType(uri) ?: "image/jpeg"
    val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) c.getString(0) else null
    } ?: "photo.jpg"
    val source = ImageDecoder.createSource(resolver, uri)
    val thumb = runCatching {
        ImageDecoder.decodeBitmap(source) { d, info, _ ->
            val s = 160f / maxOf(info.size.width, info.size.height)
            if (s < 1f) d.setTargetSize((info.size.width * s).toInt().coerceAtLeast(1), (info.size.height * s).toInt().coerceAtLeast(1))
        }.asImageBitmap()
    }.getOrNull()
    val raw = resolver.openInputStream(uri)?.use { it.readBytes() } ?: error("unreadable")
    if (type in IMAGE_TYPES && raw.size <= MAX_BYTES) return Picture(name, type, raw, thumb)
    val bitmap = ImageDecoder.decodeBitmap(source) { d, info, _ ->
        d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        val s = 2560f / maxOf(info.size.width, info.size.height)
        if (s < 1f) d.setTargetSize((info.size.width * s).toInt().coerceAtLeast(1), (info.size.height * s).toInt().coerceAtLeast(1))
    }
    val out = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.JPEG, 88, out)
    return Picture(name.substringBeforeLast('.') + ".jpg", "image/jpeg", out.toByteArray(), thumb)
}
