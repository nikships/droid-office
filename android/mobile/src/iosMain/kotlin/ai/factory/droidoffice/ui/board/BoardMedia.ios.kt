@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package ai.factory.droidoffice.ui.board

import ai.factory.droidoffice.data.toBytes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asComposeImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.uikit.LocalUIViewController
import kotlin.coroutines.resume
import kotlinx.cinterop.useContents
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.jetbrains.skia.Bitmap
import org.jetbrains.skia.ColorAlphaType
import org.jetbrains.skia.ColorType
import org.jetbrains.skia.Image
import org.jetbrains.skia.ImageInfo
import org.jetbrains.skia.impl.use
import platform.CoreGraphics.CGSizeMake
import platform.Foundation.NSData
import platform.Foundation.NSDataReadingMappedIfSafe
import platform.Foundation.NSItemProvider
import platform.Foundation.NSURL
import platform.Foundation.dataWithContentsOfURL
import platform.PhotosUI.PHPickerConfiguration
import platform.PhotosUI.PHPickerConfigurationAssetRepresentationModeCurrent
import platform.PhotosUI.PHPickerFilter
import platform.PhotosUI.PHPickerResult
import platform.PhotosUI.PHPickerViewController
import platform.PhotosUI.PHPickerViewControllerDelegateProtocol
import platform.UIKit.UIImage
import platform.UIKit.UIImageJPEGRepresentation
import platform.UIKit.UIViewController
import platform.UniformTypeIdentifiers.UTType
import platform.darwin.NSObject

internal suspend fun decode(bytes: ByteArray, full: Boolean): ImageBitmap? = withContext(Dispatchers.Default) {
    runCatching {
        Image.makeFromEncoded(bytes).use { image ->
            if (!full) return@use image.toComposeImageBitmap()
            val tile = Bitmap()
            if (tile.allocPixels(ImageInfo(image.width, image.height, ColorType.RGB_565, ColorAlphaType.OPAQUE)) && image.readPixels(tile)) {
                tile.setImmutable()
                tile.asComposeImageBitmap()
            } else {
                tile.close()
                image.toComposeImageBitmap()
            }
        }
    }.getOrNull()
}

@Composable
internal fun rememberBoardPicturePicker(onPick: (suspend () -> BoardPicture?) -> Unit): () -> Unit {
    val host = LocalUIViewController.current
    val current by rememberUpdatedState(onPick)
    // PHPicker's delegate is weak; retain it until the screen is disposed. No library permission is needed.
    val delegate = remember { PicturePicker { provider -> current { provider.readPicture() } } }
    DisposableEffect(delegate) { onDispose { delegate.close() } }
    return { delegate.present(host) }
}

private class PicturePicker(private val selected: (NSItemProvider) -> Unit) : NSObject(), PHPickerViewControllerDelegateProtocol {
    private var active: PHPickerViewController? = null

    fun present(host: UIViewController) {
        // A sheet can be swiped away without completing a pick. An old, dismissed sheet must not block the next one.
        if (host.view.window == null || host.presentedViewController != null || active?.presentingViewController != null) return
        val config = PHPickerConfiguration().apply {
            filter = PHPickerFilter.imagesFilter
            selectionLimit = 1
            preferredAssetRepresentationMode = PHPickerConfigurationAssetRepresentationModeCurrent
        }
        val picker = PHPickerViewController(config)
        picker.delegate = this
        active = picker
        host.presentViewController(picker, animated = true, completion = null)
    }

    override fun picker(picker: PHPickerViewController, didFinishPicking: List<*>) {
        if (picker != active) return
        close()
        (didFinishPicking.firstOrNull() as? PHPickerResult)?.itemProvider?.let(selected)
    }

    fun close() {
        active?.let {
            it.delegate = null
            it.dismissViewControllerAnimated(true, completion = null)
        }
        active = null
    }
}

private suspend fun NSItemProvider.readPicture(): BoardPicture? = suspendCancellableCoroutine { continuation ->
    val progress = loadFileRepresentationForTypeIdentifier("public.image") { url, _ ->
        // The provider's private file exists only inside this callback, on its background queue.
        if (continuation.isActive) continuation.resume(url?.let { runCatching { readPictureFile(it) }.getOrNull() })
    }
    continuation.invokeOnCancellation { progress.cancel() }
}

private fun readPictureFile(url: NSURL): BoardPicture? {
    val data = NSData.dataWithContentsOfURL(url, options = NSDataReadingMappedIfSafe, error = null) ?: return null
    val image = UIImage.imageWithData(data) ?: return null
    val (w, h) = image.pixels()
    if (w <= 0 || h <= 0) return null
    val mime = UTType.typeWithFilenameExtension(url.pathExtension.orEmpty())?.preferredMIMEType
    if (mime != null && mime in PICTURE_TYPES && data.length <= MAX_PICTURE_BYTES.toULong()) {
        return BoardPicture(mime, data.toBytes(), w, h)
    }
    // UIKit downsamples and applies EXIF rotation; oversized/HEIC files do not become full-size bitmaps.
    val scale = minOf(1.0, MAX_PICTURE_SIDE.toDouble() / maxOf(w, h))
    val thumb = image.imageByPreparingThumbnailOfSize(CGSizeMake(maxOf(1.0, w * scale), maxOf(1.0, h * scale))) ?: return null
    val jpeg = UIImageJPEGRepresentation(thumb, 0.88) ?: return null
    if (jpeg.length > MAX_PICTURE_BYTES.toULong()) return null
    val (width, height) = thumb.pixels()
    return BoardPicture("image/jpeg", jpeg.toBytes(), width, height)
}

private fun UIImage.pixels() = size.useContents { (width * scale).toInt() to (height * scale).toInt() }
