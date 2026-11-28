package ai.factory.droidoffice.ui.worker

import androidx.collection.LruCache
import kotlin.io.encoding.Base64
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
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import ai.factory.droidoffice.core.Markdown
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
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.ThreadPalette
import ai.factory.droidoffice.ui.theme.Palette
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

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

@Composable
private fun rememberPicture(connection: OfficeConnection, source: PictureSource, image: ThreadImage, side: Int): ImageBitmap? {
    val cacheKey = "${source.floor}/${source.worker}/${image.id}@$side"
    return key(cacheKey) {
        val picture by produceState(ThreadPictureCache.get(cacheKey), cacheKey) {
            if (value != null) return@produceState
            val bytes = connection.threadImage(source.floor, source.worker, image.id) ?: return@produceState
            decodeScaled(bytes, side)?.let {
                ThreadPictureCache.put(cacheKey, it)
                value = it
            }
        }
        picture
    }
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
    var viewing by remember(images) { mutableStateOf<Int?>(null) }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = if (end) Alignment.End else Alignment.Start) {
        images.forEachIndexed { i, image ->
            val name = if (images.size > 1) "$title · ${i + 1} of ${images.size}" else title
            val picture = rememberPicture(connection, source, image, THUMB_SIDE)
            val ratio = shape(image, picture)
            val shape = RoundedCornerShape(4.dp)
            Box(
                Modifier.widthIn(max = 360.dp).heightIn(max = 280.dp).aspectRatio(ratio, matchHeightConstraintsFirst = ratio < 1f)
                    .clip(shape).border(1.dp, Palette.Border, shape).background(Palette.Bg)
                    .clickable(role = Role.Image, onClickLabel = "Open the picture") { viewing = i }
                    .semantics { contentDescription = name }
                    .tagged(Tags.Worker.threadImage(image.id)),
                contentAlignment = Alignment.Center,
            ) {
                if (picture != null) Image(picture, null, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
                else Spinner(Modifier.size(14.dp), Palette.TextSecondary)
            }
        }
    }
    viewing?.let { index -> PictureViewer(connection, source, images, index, title, about, onPage = { viewing = it }, onClose = { viewing = null }) }
}

private fun shape(image: ThreadImage, picture: ImageBitmap?): Float {
    val w = image.width ?: picture?.width
    val h = image.height ?: picture?.height
    return if (w != null && h != null && w > 0 && h > 0) (w.toFloat() / h).coerceIn(0.2f, 5f) else 4f / 3f
}

/**
 * An image a reply's Markdown shows on a line of its own: a file on the office's machine (read from the
 * worker's [PictureSource]) or a web picture, both fetched through the office. Its alt text stands in
 * when it can't be shown.
 */
@Composable
internal fun MarkdownImage(alt: String, src: String, style: TextStyle) {
    val source = LocalPictureSource.current
    val connection = LocalGraph.current.connection
    val local = remember(src) { Markdown.localImagePath(src) }
    val web = src.startsWith("https://", ignoreCase = true) || src.startsWith("http://", ignoreCase = true)
    val key = "${source?.floor}/${source?.worker}/md:$src@$THUMB_SIDE"
    var failed by remember(key) { mutableStateOf(if (local != null) source == null else !web) }
    val picture by produceState(ThreadPictureCache.get(key), key, failed) {
        if (value != null || failed) return@produceState
        val bytes = if (local != null && source != null) connection.threadFileImage(source.floor, source.worker, local) else connection.webImage(src)
        val decoded = bytes?.let { decodeScaled(it, THUMB_SIDE) }
        if (decoded == null) failed = true
        else {
            ThreadPictureCache.put(key, decoded)
            value = decoded
        }
    }
    if (failed && picture == null) {
        val uriHandler = LocalUriHandler.current
        val provider = remember(src) { if (web) pictureHost(src) else null }
        val shape = RoundedCornerShape(4.dp)
        Row(
            Modifier.fillMaxWidth().clip(shape).border(1.dp, ThreadPalette.BorderStrong, shape).padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(OfficeIcons.Picture, null, tint = ThreadPalette.TextTertiary, modifier = Modifier.size(14.dp))
            Text("Preview unavailable", style = style.copy(fontSize = 12.sp, color = ThreadPalette.TextTertiary))
            if (alt.isNotBlank()) Text(alt, style = style.copy(color = ThreadPalette.TextSecondary), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (provider != null) {
                Text(
                    "Open on $provider",
                    style = style.copy(color = ThreadPalette.Link),
                    maxLines = 1,
                    modifier = Modifier.clickable(role = Role.Button) { runCatching { uriHandler.openUri(src) } },
                )
            }
        }
        return
    }
    val ratio = picture?.let { (it.width.toFloat() / it.height).coerceIn(0.2f, 5f) } ?: (16f / 9f)
    val shape = RoundedCornerShape(4.dp)
    var viewing by remember(key) { mutableStateOf(false) }
    Box(
        Modifier.fillMaxWidth().heightIn(max = 480.dp).aspectRatio(ratio, matchHeightConstraintsFirst = ratio < 1f)
            .clip(shape).border(1.dp, Palette.Border, shape).background(Palette.Bg)
            .clickable(role = Role.Image, enabled = picture != null, onClickLabel = "Open the picture") { viewing = true }
            .semantics { contentDescription = alt }
            .tagged(Tags.Worker.THREAD_MD_IMAGE),
        contentAlignment = Alignment.Center,
    ) {
        val shown = picture
        if (shown != null) Image(shown, null, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
        else Spinner(Modifier.size(14.dp), Palette.TextSecondary)
    }
    val full by produceState<ImageBitmap?>(null, key, viewing) {
        if (viewing) {
            val bytes = if (local != null && source != null) connection.threadFileImage(source.floor, source.worker, local) else connection.webImage(src)
            value = bytes?.let { decodeScaled(it, FULL_SIDE) }
        }
    }
    val download = rememberThreadDownload("image", "image/*") {
        if (local != null && source != null) connection.threadFileImage(source.floor, source.worker, local) else connection.webImage(src)
    }
    if (viewing) FullscreenPictureDialog(full ?: picture, null, null, alt.ifBlank { "Image preview" }, src, onDownload = download, onClose = { viewing = false })
}

/** One picture over everything, fit to the screen with pinch-zoom, until the owner taps it, ✕ or Back. */
@Composable
private fun PictureViewer(connection: OfficeConnection, source: PictureSource, images: List<ThreadImage>, index: Int, title: String, about: String?, onPage: (Int) -> Unit, onClose: () -> Unit) {
    val image = images[index]
    val name = if (images.size > 1) "$title · ${index + 1} of ${images.size}" else title
    val picture = rememberPicture(connection, source, image, FULL_SIDE) ?: rememberPicture(connection, source, image, THUMB_SIDE)
    val extension = image.type.substringAfter('/').replace("jpeg", "jpg")
    val download = rememberThreadDownload("image.$extension", image.type) { connection.threadImage(source.floor, source.worker, image.id) }
    FullscreenPictureDialog(picture, image.width, image.height, name, about, index, images.size, onPage, download, onClose)
}

/** Opens a tapped Raw TTY Kitty image in the shared fullscreen viewer. */
@Composable
internal fun KittyPictureViewer(image: PageMsg.Image, about: String?, onClose: () -> Unit) {
    val picture by produceState<ImageBitmap?>(null, image) {
        val bytes = withContext(Dispatchers.Default) {
            runCatching { Base64.decode(image.data) }.getOrNull()
        } ?: return@produceState
        value = decodeScaled(bytes, FULL_SIDE)
    }
    val download = rememberThreadDownload("terminal-image.png", "image/png") {
        runCatching { Base64.decode(image.data) }.getOrNull()
    }
    FullscreenPictureDialog(picture, image.width, image.height, "Terminal image", about, onDownload = download, onClose = onClose)
}

@Composable
internal fun FullscreenPictureDialog(
    picture: ImageBitmap?,
    width: Int?,
    height: Int?,
    name: String,
    about: String?,
    page: Int = 0,
    pages: Int = 1,
    onPage: ((Int) -> Unit)? = null,
    onDownload: (() -> Unit)? = null,
    onClose: () -> Unit,
) {
    Dialog(onDismissRequest = onClose, properties = workerDialogProperties()) {
        var boxSize by remember { mutableStateOf(IntSize.Zero) }
        var transform by remember(picture) { mutableStateOf(PictureTransform()) }
        val imgW = picture?.width ?: width ?: 0
        val imgH = picture?.height ?: height ?: 0
        Column(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.6f)).systemBarsPadding().tagged(Tags.Worker.THREAD_IMAGE_VIEWER)) {
            Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(name, style = MaterialTheme.typography.titleSmall, color = Palette.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val sub = listOfNotNull(about, if (width != null && height != null) "$width × $height" else null).joinToString(" · ")
                    if (sub.isNotEmpty()) Text(sub, style = LocalOfficeType.current.monoBody.copy(color = Palette.TextSecondary), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (pages > 1) Row(Modifier.align(Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { onPage?.invoke(page - 1) }, enabled = page > 0, modifier = Modifier.tagged(Tags.Worker.THREAD_IMAGE_PREVIOUS)) {
                    Icon(OfficeIcons.ChevronLeft, "Previous image", tint = Palette.TextSecondary)
                }
                Text("${page + 1} / $pages", style = LocalOfficeType.current.monoBody.copy(color = Palette.TextSecondary), modifier = Modifier.tagged(Tags.Worker.THREAD_IMAGE_COUNT))
                IconButton(onClick = { onPage?.invoke(page + 1) }, enabled = page < pages - 1, modifier = Modifier.tagged(Tags.Worker.THREAD_IMAGE_NEXT)) {
                    Icon(OfficeIcons.Chevron, "Next image", tint = Palette.TextSecondary)
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
                            val next = PictureZoom.step(
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
                            transform = PictureZoom.clamp(next.zoom.coerceAtMost(4f), next.panX, next.panY, imgW, imgH, boxSize.width.toFloat(), boxSize.height.toFloat())
                        }
                    }
                    .pointerInput(picture, boxSize) {
                        detectTapGestures(
                            onDoubleTap = { pos ->
                                if (picture != null) {
                                    transform = if (transform.zoom > 1.05f) PictureTransform()
                                    else PictureZoom.step(transform, 2f / transform.zoom, 0f, 0f, pos.x, pos.y, imgW, imgH, boxSize.width.toFloat(), boxSize.height.toFloat())
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
            fun zoomTo(next: Float) {
                val target = next.coerceIn(1f, 4f)
                transform = PictureZoom.step(
                    transform,
                    target / transform.zoom,
                    0f,
                    0f,
                    boxSize.width / 2f,
                    boxSize.height / 2f,
                    imgW,
                    imgH,
                    boxSize.width.toFloat(),
                    boxSize.height.toFloat(),
                )
            }
            Row(
                Modifier.align(Alignment.CenterHorizontally).padding(bottom = 24.dp)
                    .background(Palette.Surface, RoundedCornerShape(4.dp))
                    .border(1.dp, Palette.Border, RoundedCornerShape(4.dp))
                    .padding(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = { zoomTo(transform.zoom - 0.5f) }, enabled = picture != null && transform.zoom > 1f) {
                    Icon(OfficeIcons.Minus, "Zoom out", tint = Palette.TextSecondary)
                }
                Text(
                    "${(transform.zoom * 100).toInt()}%",
                    style = LocalOfficeType.current.monoBody.copy(color = Palette.TextSecondary),
                    modifier = Modifier.clip(RoundedCornerShape(4.dp)).clickable(role = Role.Button, onClickLabel = "Reset zoom") { transform = PictureTransform() }.padding(horizontal = 12.dp, vertical = 8.dp),
                )
                IconButton(onClick = { zoomTo(transform.zoom + 0.5f) }, enabled = picture != null && transform.zoom < 4f) {
                    Icon(OfficeIcons.Plus, "Zoom in", tint = Palette.TextSecondary)
                }
                IconButton(onClick = onClose, modifier = Modifier.tagged(Tags.Worker.THREAD_IMAGE_CLOSE)) {
                    Icon(Icons.Filled.Close, contentDescription = "Close the picture", tint = Palette.TextSecondary)
                }
                if (onDownload != null) IconButton(onClick = onDownload, modifier = Modifier.tagged(Tags.Worker.THREAD_IMAGE_DOWNLOAD)) {
                    Icon(OfficeIcons.Download, "Download image", tint = Palette.TextSecondary)
                }
            }
        }
    }
}
