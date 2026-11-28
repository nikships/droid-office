@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package ai.factory.droidoffice.ui.worker

import ai.factory.droidoffice.data.toData
import ai.factory.droidoffice.ui.LocalSnackbar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.uikit.LocalUIViewController
import kotlinx.cinterop.useContents
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import platform.CoreGraphics.CGRectMake
import platform.Foundation.NSDataWritingFileProtectionComplete
import platform.Foundation.NSFileManager
import platform.Foundation.NSTemporaryDirectory
import platform.Foundation.NSURL
import platform.Foundation.NSUUID
import platform.Foundation.writeToURL
import platform.UIKit.UIActivityViewController
import platform.UIKit.UIDocumentPickerDelegateProtocol
import platform.UIKit.UIDocumentPickerViewController
import platform.UIKit.UIViewController
import platform.UIKit.modalInPresentation
import platform.UIKit.popoverPresentationController
import platform.UniformTypeIdentifiers.UTType
import platform.darwin.NSObject

@Composable
internal fun rememberThreadDownload(name: String, type: String, load: suspend () -> ByteArray?): () -> Unit {
    val host = LocalUIViewController.current
    val scope = rememberCoroutineScope()
    val snackbar = LocalSnackbar.current
    return {
        scope.launch {
            try {
                val bytes = load() ?: error("File unavailable")
                if (host.export(name, type, bytes, share = false)) snackbar.showSnackbar("Saved")
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                snackbar.showSnackbar("Couldn't save this file")
            }
        }
    }
}

@Composable
internal fun rememberSvgShare(): suspend (String) -> Unit {
    val host = LocalUIViewController.current
    return { svg -> host.export("diagram.svg", "image/svg+xml", svg.encodeToByteArray(), share = true) }
}

/** Only explicit Save/Share writes to an isolated temp directory. Pass the file, not the markup
 * or the authenticated URL, to the system. Clean up on success, cancellation, error and disposal. */
private suspend fun UIViewController.export(name: String, type: String, bytes: ByteArray, share: Boolean): Boolean {
    val files = NSFileManager.defaultManager
    val dir = NSURL.fileURLWithPath(NSTemporaryDirectory(), isDirectory = true).URLByAppendingPathComponent(NSUUID().UUIDString, true)!!
    val leaf = name.filter { it.isLetterOrDigit() || it in "-_. " }.trim('.', ' ').take(100).ifEmpty { "file" }
    val ext = if (type == "image/*") imageExtension(bytes) else UTType.typeWithMIMEType(type)?.preferredFilenameExtension
    val file = dir.URLByAppendingPathComponent(if ('.' !in leaf && ext != null) "$leaf.$ext" else leaf, false)!!
    try {
        withContext(Dispatchers.Default) {
            check(files.createDirectoryAtURL(dir, withIntermediateDirectories = false, attributes = null, error = null))
            check(bytes.toData().writeToURL(file, options = NSDataWritingFileProtectionComplete, error = null))
        }
        return withContext(Dispatchers.Main.immediate) {
            check(view.window != null && presentedViewController == null)
            if (share) shareFile(file) else SaveFile(file).show(this@export)
        }
    } finally {
        withContext(NonCancellable + Dispatchers.Default) { files.removeItemAtURL(dir, error = null) }
    }
}

private fun imageExtension(bytes: ByteArray): String? = when {
    bytes.size >= 8 && bytes[0] == 0x89.toByte() && bytes.decodeToString(1, 4) == "PNG" -> "png"
    bytes.size >= 3 && bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte() -> "jpg"
    bytes.size >= 6 && bytes.decodeToString(0, 3) == "GIF" -> "gif"
    bytes.size >= 12 && bytes.decodeToString(0, 4) == "RIFF" && bytes.decodeToString(8, 12) == "WEBP" -> "webp"
    else -> null
}

private class SaveFile(file: NSURL) : NSObject(), UIDocumentPickerDelegateProtocol {
    private val result = CompletableDeferred<Boolean>()
    private val picker = UIDocumentPickerViewController(forExportingURLs = listOf(file), asCopy = true)

    suspend fun show(host: UIViewController): Boolean {
        picker.delegate = this
        picker.modalInPresentation = true
        host.presentViewController(picker, animated = true, completion = null)
        try {
            return result.await()
        } finally {
            picker.delegate = null
            if (!result.isCompleted) picker.dismissViewControllerAnimated(false, completion = null)
        }
    }

    override fun documentPicker(controller: UIDocumentPickerViewController, didPickDocumentsAtURLs: List<*>) { result.complete(didPickDocumentsAtURLs.isNotEmpty()) }
    override fun documentPickerWasCancelled(controller: UIDocumentPickerViewController) { result.complete(false) }
}

private suspend fun UIViewController.shareFile(file: NSURL): Boolean {
    val sheet = UIActivityViewController(activityItems = listOf(file), applicationActivities = null)
    sheet.popoverPresentationController?.let {
        it.sourceView = view
        it.sourceRect = view.bounds.useContents { CGRectMake(size.width / 2, size.height / 2, 1.0, 1.0) }
        it.permittedArrowDirections = 0uL
    }
    val done = CompletableDeferred<Boolean>()
    sheet.completionWithItemsHandler = { _, completed, _, error ->
        if (error == null) done.complete(completed) else done.completeExceptionally(IllegalStateException("Share failed"))
    }
    presentViewController(sheet, animated = true, completion = null)
    try {
        return done.await()
    } finally {
        sheet.completionWithItemsHandler = null
        if (!done.isCompleted) sheet.dismissViewControllerAnimated(false, completion = null)
    }
}
