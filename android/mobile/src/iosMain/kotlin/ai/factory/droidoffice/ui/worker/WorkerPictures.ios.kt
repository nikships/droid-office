@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package ai.factory.droidoffice.ui.worker

import ai.factory.droidoffice.data.toBytes
import ai.factory.droidoffice.data.toData
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.uikit.LocalUIViewController
import kotlin.coroutines.resume
import kotlinx.cinterop.useContents
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.jetbrains.skia.Image
import org.jetbrains.skia.impl.use
import platform.CoreGraphics.CGSizeMake
import platform.Foundation.NSData
import platform.Foundation.NSDataReadingMappedIfSafe
import platform.Foundation.NSItemProvider
import platform.Foundation.dataWithContentsOfURL
import platform.PhotosUI.PHPickerConfiguration
import platform.PhotosUI.PHPickerConfigurationAssetRepresentationModeCurrent
import platform.PhotosUI.PHPickerConfigurationSelectionOrdered
import platform.PhotosUI.PHPickerFilter
import platform.PhotosUI.PHPickerResult
import platform.PhotosUI.PHPickerViewController
import platform.PhotosUI.PHPickerViewControllerDelegateProtocol
import platform.UIKit.UIImage
import platform.UIKit.UIImageJPEGRepresentation
import platform.UIKit.UIImagePNGRepresentation
import platform.UIKit.UIViewController
import platform.UniformTypeIdentifiers.UTType
import platform.darwin.NSObject

@Composable
internal fun rememberPicturePicker(limit: Int, selected: (List<PictureLoader>) -> Unit): () -> Unit {
    val host = LocalUIViewController.current
    val latest by rememberUpdatedState(selected)
    val delegate = remember(limit) { PicturePicker(limit) { latest(it) } }
    DisposableEffect(delegate) { onDispose { delegate.close() } }
    return { delegate.show(host) }
}

private class PicturePicker(private val limit: Int, private val selected: (List<PictureLoader>) -> Unit) : NSObject(), PHPickerViewControllerDelegateProtocol {
    private var picker: PHPickerViewController? = null

    fun show(host: UIViewController) {
        if (picker != null || host.presentedViewController != null) return
        val config = PHPickerConfiguration().apply {
            filter = PHPickerFilter.imagesFilter
            selectionLimit = limit.toLong()
            selection = PHPickerConfigurationSelectionOrdered
            preferredAssetRepresentationMode = PHPickerConfigurationAssetRepresentationModeCurrent
        }
        picker = PHPickerViewController(config).also {
            it.delegate = this
            host.presentViewController(it, animated = true, completion = null)
        }
    }

    override fun picker(picker: PHPickerViewController, didFinishPicking: List<*>) {
        if (picker != this.picker) return
        close()
        selected(didFinishPicking.filterIsInstance<PHPickerResult>().map { result -> suspend { result.itemProvider.readPicture() } })
    }

    fun close() {
        picker?.delegate = null
        picker?.dismissViewControllerAnimated(true, completion = null)
        picker = null
    }
}

private suspend fun NSItemProvider.readPicture(): Picture? = suspendCancellableCoroutine { continuation ->
    // The temporary representation only exists inside the provider's background callback. Map it
    // rather than reading a large camera original into the Kotlin heap when it needs conversion.
    val progress = loadFileRepresentationForTypeIdentifier("public.image") { url, _ ->
        if (continuation.isActive) continuation.resume(runCatching {
            if (url == null) return@runCatching null
            val data = NSData.dataWithContentsOfURL(url, NSDataReadingMappedIfSafe, null) ?: return@runCatching null
            val image = UIImage.imageWithData(data) ?: return@runCatching null
            val type = UTType.typeWithFilenameExtension(url.pathExtension.orEmpty())?.preferredMIMEType
            val name = suggestedName?.takeIf { it.isNotBlank() } ?: url.lastPathComponent ?: "photo"
            val thumb = image.thumbnail(160)?.bitmap()
            if (type != null && type in IMAGE_TYPES && data.length <= MAX_BYTES.toULong()) {
                val suffix = url.pathExtension.orEmpty()
                Picture(if ('.' !in name && suffix.isNotEmpty()) "$name.$suffix" else name, type, data.toBytes(), thumb)
            } else {
                val jpeg = image.thumbnail(2560)?.let { UIImageJPEGRepresentation(it, 0.88) } ?: return@runCatching null
                if (jpeg.length > MAX_BYTES.toULong()) null else Picture(name.substringBeforeLast('.') + ".jpg", "image/jpeg", jpeg.toBytes(), thumb)
            }
        }.getOrNull())
    }
    continuation.invokeOnCancellation { progress.cancel() }
}

internal suspend fun decodeScaled(bytes: ByteArray, side: Int): ImageBitmap? = withContext(Dispatchers.Default) {
    runCatching { UIImage.imageWithData(bytes.toData())?.thumbnail(side)?.bitmap() }.getOrNull()
}

/** ImageIO-backed preparation applies the EXIF transform before the bounded preview is decoded in Skia. */
private fun UIImage.thumbnail(side: Int): UIImage? = size.useContents {
    if (width <= 0 || height <= 0) return@useContents null
    val ratio = minOf(scale, side / maxOf(width, height))
    imageByPreparingThumbnailOfSize(CGSizeMake(maxOf(1.0, width * ratio), maxOf(1.0, height * ratio)))
}

private fun UIImage.bitmap(): ImageBitmap? = UIImagePNGRepresentation(this)?.let { png ->
    Image.makeFromEncoded(png.toBytes()).use { it.toComposeImageBitmap() }
}
