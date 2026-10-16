package ai.factory.droidoffice.ui.board

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import ai.factory.droidoffice.session.OfficeConnection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Grid thumbnails, kept across screens by the render they came from, so scrolling back or opening
 * the tab again doesn't fetch them twice. A card with a newer render gets a new key.
 */
object BoardThumbs {
    private val cache = object : LruCache<String, ImageBitmap>(48 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ImageBitmap) = value.width * value.height * 4
    }

    fun key(floor: String, card: String, at: Long) = "$floor/$card@$at"
    fun get(key: String): ImageBitmap? = cache.get(key)
    fun put(key: String, image: ImageBitmap) {
        cache.put(key, image)
    }
}

/** A card's thumbnail from its latest render [at]; null while it loads, or when it has none. */
@Composable
fun rememberThumb(connection: OfficeConnection, floor: String, card: String, at: Long?): ImageBitmap? {
    val key = at?.let { BoardThumbs.key(floor, card, it) }
    val image by produceState(key?.let(BoardThumbs::get), key) {
        val version = at
        if (version == null) {
            value = null
            return@produceState
        }
        val k = BoardThumbs.key(floor, card, version)
        BoardThumbs.get(k)?.let {
            value = it
            return@produceState
        }
        val bytes = connection.boardImage(floor, card, thumb = true, tile = 0, version = version) ?: return@produceState
        decode(bytes, full = false)?.let {
            BoardThumbs.put(k, it)
            value = it
        }
    }
    return image
}

/**
 * Decodes a PNG off the main thread. A full page's tiles are 1280×2048 each, up to eight of them, so
 * they're decoded without alpha to halve what they hold in memory; the page is opaque anyway.
 */
suspend fun decode(bytes: ByteArray, full: Boolean): ImageBitmap? = withContext(Dispatchers.Default) {
    val opts = BitmapFactory.Options().apply { if (full) inPreferredConfig = Bitmap.Config.RGB_565 }
    runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)?.asImageBitmap() }.getOrNull()
}
