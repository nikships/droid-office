package ai.factory.droidoffice.ui.worker

import android.graphics.ImageDecoder
import android.util.Base64
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import ai.factory.droidoffice.core.PageMsg
import ai.factory.droidoffice.core.PictureTransform
import ai.factory.droidoffice.core.PictureZoom
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.ThreadImage
import ai.factory.droidoffice.session.OfficeConnection
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.Palette
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.nio.ByteBuffer

/** The floor and worker a Thread is read on: its pictures are fetched from there. */
internal data class PictureSource(val floor: String, val worker: String)

internal val LocalPictureSource = staticCompositionLocalOf<PictureSource?> { null }

@Composable
internal fun ProvidePictures(source: PictureSource?, content: @Composable () -> Unit) = CompositionLocalProvider(LocalPictureSource provides source, content = content)

/** A thumbnail's longest side when decoded, and the viewer's: enough for the screen, far less than a 4K screenshot holds. */
private const val THUMB_SIDE = 720
private const val FULL_SIDE = 2048

/** Decoded pictures by floor, worker, id and size, so scrolling back or reopening the Thread doesn't fetch them twice. */
private object ThreadPictureCache {
    private val cache = object : LruCache<String, ImageBitmap>(32 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ImageBitmap) = value.width * value.height * 4
    }

    fun get(key: String): ImageBitmap? = cache.get(key)
    fun put(key: String, image: ImageBitmap) {
        cache.put(key, image)
    }
}

/**
 * Decodes off the main thread, halving the size until its longest side fits [side]. ImageDecoder turns a
 * camera photo the way its EXIF orientation says, as the composer's thumbnail does; BitmapFactory would leave it sideways.
 */
private suspend fun decodeScaled(bytes: ByteArray, side: Int): ImageBitmap? = withContext(Dispatchers.Default) {
    runCatching {
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) { d, info, _ ->
            var sample = 1
            while (maxOf(info.size.width, info.size.height) / (sample * 2) >= side) sample *= 2
            d.setTargetSampleSize(sample)
        }.asImageBitmap()
    }.getOrNull()
}

@Composable
private fun rememberPicture(connection: OfficeConnection, source: PictureSource, image: ThreadImage, side: Int): ImageBitmap? {
    val key = "${source.floor}/${source.worker}/${image.id}@$side"
    val picture by produceState(ThreadPictureCache.get(key), key) {
        if (value != null) return@produceState
        val bytes = connection.threadImage(source.floor, source.worker, image.id) ?: return@produceState
        decodeScaled(bytes, side)?.let {
            ThreadPictureCache.put(key, it)
            value = it
        }
    }
    return picture
}

/**
 * The pictures a tool returned or a message carried, one under another at their own shape, on the
 * owner's side for theirs. Tapping one opens it at full size. Nothing shows without a [PictureSource].
 */
@Composable
internal fun ThreadPictures(images: List<ThreadImage>, title: String, about: String?, end: Boolean, modifier: Modifier = Modifier) {
    val source = LocalPictureSource.current ?: return
    if (images.isEmpty()) return
    val connection = LocalGraph.current.connection
    var viewing by remember { mutableStateOf<Pair<ThreadImage, String>?>(null) }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = if (end) Alignment.End else Alignment.Start) {
        images.forEachIndexed { i, image ->
            val name = if (images.size > 1) "$title · ${i + 1} of ${images.size}" else title
            val picture = rememberPicture(connection, source, image, THUMB_SIDE)
            val ratio = shape(image, picture)
            val shape = RoundedCornerShape(4.dp)
            Box(
                Modifier.widthIn(max = 360.dp).heightIn(max = 280.dp).aspectRatio(ratio, matchHeightConstraintsFirst = ratio < 1f)
                    .clip(shape).border(1.dp, Palette.Border, shape).background(Palette.Bg)
                    .clickable(role = Role.Image, onClickLabel = "Open the picture") { viewing = image to name }
                    .semantics { contentDescription = name }
                    .tagged(Tags.Worker.threadImage(image.id)),
                contentAlignment = Alignment.Center,
            ) {
                if (picture != null) Image(picture, null, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
                else Spinner(Modifier.size(14.dp), Palette.TextSecondary)
            }
        }
    }
    viewing?.let { (image, name) -> PictureViewer(connection, source, image, name, about) { viewing = null } }
}

private fun shape(image: ThreadImage, picture: ImageBitmap?): Float {
    val w = image.width ?: picture?.width
    val h = image.height ?: picture?.height
    return if (w != null && h != null && w > 0 && h > 0) (w.toFloat() / h).coerceIn(0.2f, 5f) else 4f / 3f
}

/** One picture over everything, fit to the screen with pinch-zoom, until the owner taps it, ✕ or Back. */
@Composable
private fun PictureViewer(connection: OfficeConnection, source: PictureSource, image: ThreadImage, name: String, about: String?, onClose: () -> Unit) {
    val picture = rememberPicture(connection, source, image, FULL_SIDE) ?: rememberPicture(connection, source, image, THUMB_SIDE)
    FullscreenPictureDialog(picture, image.width, image.height, name, about, onClose)
}

/** Opens a tapped Raw TTY Kitty image in the shared fullscreen viewer. */
@Composable
internal fun KittyPictureViewer(image: PageMsg.Image, about: String?, onClose: () -> Unit) {
    val picture by produceState<ImageBitmap?>(null, image) {
        val bytes = withContext(Dispatchers.Default) {
            runCatching { Base64.decode(image.data, Base64.DEFAULT) }.getOrNull()
        } ?: return@produceState
        value = decodeScaled(bytes, FULL_SIDE)
    }
    FullscreenPictureDialog(picture, image.width, image.height, "Terminal image", about, onClose)
}

@Composable
internal fun FullscreenPictureDialog(
    picture: ImageBitmap?,
    width: Int?,
    height: Int?,
    name: String,
    about: String?,
    onClose: () -> Unit,
) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        var boxSize by remember { mutableStateOf(IntSize.Zero) }
        var transform by remember(picture) { mutableStateOf(PictureTransform()) }
        val imgW = picture?.width ?: width ?: 0
        val imgH = picture?.height ?: height ?: 0
        Column(Modifier.fillMaxSize().background(Palette.Bg).systemBarsPadding().tagged(Tags.Worker.THREAD_IMAGE_VIEWER)) {
            Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(name, style = MaterialTheme.typography.titleSmall, color = Palette.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val sub = listOfNotNull(about, if (width != null && height != null) "$width × $height" else null).joinToString(" · ")
                    if (sub.isNotEmpty()) Text(sub, style = LocalOfficeType.current.monoBody.copy(color = Palette.TextSecondary), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                IconButton(onClick = onClose, modifier = Modifier.tagged(Tags.Worker.THREAD_IMAGE_CLOSE)) {
                    Icon(Icons.Filled.Close, contentDescription = "Close the picture", tint = Palette.Text)
                }
            }
            Box(
                Modifier.weight(1f).fillMaxWidth().padding(12.dp).clipToBounds()
                    .onSizeChanged { next ->
                        boxSize = next
                        transform = PictureZoom.clamp(transform.zoom, transform.panX, transform.panY, imgW, imgH, next.width.toFloat(), next.height.toFloat())
                    }
                    .semantics {
                        onClick(label = "Close the picture") {
                            onClose()
                            true
                        }
                    }
                    .pointerInput(picture, boxSize) {
                        detectTransformGestures { centroid, pan, gestureZoom, _ ->
                            transform = PictureZoom.step(
                                transform,
                                gestureZoom,
                                pan.x,
                                pan.y,
                                centroid.x,
                                centroid.y,
                                imgW,
                                imgH,
                                boxSize.width.toFloat(),
                                boxSize.height.toFloat(),
                            )
                        }
                    }
                    .pointerInput(picture, boxSize) {
                        detectTapGestures(
                            onDoubleTap = { pos ->
                                if (picture != null) {
                                    transform = PictureZoom.doubleTap(transform, pos.x, pos.y, imgW, imgH, boxSize.width.toFloat(), boxSize.height.toFloat())
                                }
                            },
                            onTap = {
                                if (transform.zoom <= 1.05f) onClose()
                            },
                        )
                    },
                contentAlignment = Alignment.Center,
            ) {
                if (picture != null) {
                    Image(
                        picture,
                        name,
                        Modifier.fillMaxSize().graphicsLayer {
                            scaleX = transform.zoom
                            scaleY = transform.zoom
                            translationX = transform.panX
                            translationY = transform.panY
                        },
                        contentScale = ContentScale.Fit,
                    )
                } else {
                    Spinner(Modifier.size(20.dp), Palette.Accent)
                }
            }
        }
    }
}
