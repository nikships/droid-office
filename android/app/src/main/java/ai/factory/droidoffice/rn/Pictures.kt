package ai.factory.droidoffice.rn

import ai.factory.droidoffice.core.PictureLimits
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
            "data:image/jpeg;base64," + Base64.encodeToString(jpeg(source, 160, 80), Base64.NO_WRAP)
        }.getOrNull()
        if (type in TYPES) {
            val raw = resolver.openInputStream(uri)?.use { PictureLimits.read(it) }
            if (raw != null) return Picture(name, type, raw, preview)
        }
        // Decode directly from the provider at the target size, not from a full-size byte array.
        val bytes = jpeg(source, 2560, 88)
        check(bytes.size <= PictureLimits.MAX_BYTES) { "The picture is too large." }
        return Picture(name.substringBeforeLast('.') + ".jpg", "image/jpeg", bytes, preview)
    }

    private fun jpeg(source: ImageDecoder.Source, edge: Int, quality: Int): ByteArray {
        val bitmap = ImageDecoder.decodeBitmap(source) { d, info, _ ->
            d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            val (width, height) = PictureLimits.size(info.size.width, info.size.height, edge)
            d.setTargetSize(width, height)
        }
        try {
            return ByteArrayOutputStream().use { out ->
                check(bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)) { "Couldn't encode the picture." }
                out.toByteArray()
            }
        } finally {
            bitmap.recycle()
        }
    }
}
