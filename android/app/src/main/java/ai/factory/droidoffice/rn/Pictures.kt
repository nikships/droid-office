package ai.factory.droidoffice.rn

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import java.io.ByteArrayOutputStream

/** A picked picture, ready for POST /api/prompt/image, and a small preview the page can show. */
class Picture(val name: String, val type: String, val bytes: ByteArray, val preview: String?)

object Pictures {
    /** The kinds of picture the office takes with a prompt (src/shared/drops.ts PROMPT_IMAGE_TYPES). */
    private val TYPES = setOf("image/png", "image/jpeg", "image/gif", "image/webp")
    private const val MAX_BYTES = 25 * 1024 * 1024

    /**
     * Reads a picked picture. One the office won't take as it is (HEIC, say, or over 25 MB) is
     * re-encoded as a JPEG no wider than 2560 px. The preview is a data: URI, never a path.
     */
    fun load(context: Context, uri: Uri): Picture {
        val resolver = context.contentResolver
        val type = resolver.getType(uri) ?: "image/jpeg"
        val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }?.take(120) ?: "photo.jpg"
        val source = ImageDecoder.createSource(resolver, uri)
        val preview = runCatching {
            val thumb = ImageDecoder.decodeBitmap(source) { d, info, _ ->
                d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                val s = 160f / maxOf(info.size.width, info.size.height)
                if (s < 1f) d.setTargetSize((info.size.width * s).toInt().coerceAtLeast(1), (info.size.height * s).toInt().coerceAtLeast(1))
            }
            val out = ByteArrayOutputStream()
            thumb.compress(Bitmap.CompressFormat.JPEG, 80, out)
            "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        }.getOrNull()
        val raw = resolver.openInputStream(uri)?.use { it.readBytes() } ?: error("unreadable")
        if (type in TYPES && raw.size <= MAX_BYTES) return Picture(name, type, raw, preview)
        val bitmap = ImageDecoder.decodeBitmap(source) { d, info, _ ->
            d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            val s = 2560f / maxOf(info.size.width, info.size.height)
            if (s < 1f) d.setTargetSize((info.size.width * s).toInt(), (info.size.height * s).toInt())
        }
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 88, out)
        return Picture(name.substringBeforeLast('.') + ".jpg", "image/jpeg", out.toByteArray(), preview)
    }
}
