package ai.factory.droidoffice.ui.board

import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.WbPageMsg
import ai.factory.droidoffice.session.OfficeConnection
import ai.factory.droidoffice.ui.components.tagged
import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
internal fun rememberCardPage(connection: OfficeConnection, floor: String, card: String, capability: String?, onMessage: (WbPageMsg) -> Unit): CardPage? {
    val context = LocalContext.current
    if (!remember { CardPage.supported() }) return null
    var generation by remember(card) { mutableIntStateOf(0) }
    // A capability refresh reaches the running Android page through WbPage.card; don't lose its scroll or focus.
    return remember(connection, floor, card, generation) {
        CardPage(context, card, object : CardFiles {
            override fun card(cap: String, path: String) = connection.cardFile(cap, path)
            override fun picture(hash: String) = connection.boardFile(floor, card, hash)
        }, onMessage, onGone = { generation++ })
    }
}

@Composable
internal fun LiveCardSurface(page: CardPage, modifier: Modifier) {
    AndroidView(factory = { page.view }, modifier = modifier)
}

@Composable
internal fun CardFullscreen(page: CardPage?, immersive: Boolean, onExit: () -> Unit, exitButton: @Composable () -> Unit) {
    val shown = page?.fullscreen
    if (shown != null) {
        key(shown) { AndroidView(factory = { shown }, modifier = Modifier.fillMaxSize().background(Color.Black).tagged(Tags.Board.VIDEO_FULLSCREEN)) }
        BackHandler { page.leaveFullscreen() }
    } else if (immersive) {
        exitButton()
        BackHandler(onBack = onExit)
    }
    val on = immersive || shown != null
    val view = LocalView.current
    DisposableEffect(on) {
        val window = (view.context as? Activity)?.window
        val controller = window?.let { WindowCompat.getInsetsController(it, view) }
        if (on && controller != null) {
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        }
        onDispose { if (on) controller?.show(WindowInsetsCompat.Type.systemBars()) }
    }
}

/** Full page tiles are opaque 1280×2048 PNGs; decode those without alpha to halve their memory. */
suspend fun decode(bytes: ByteArray, full: Boolean): ImageBitmap? = withContext(Dispatchers.Default) {
    val opts = BitmapFactory.Options().apply { if (full) inPreferredConfig = Bitmap.Config.RGB_565 }
    runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)?.asImageBitmap() }.getOrNull()
}

@Composable
internal fun rememberBoardPicturePicker(onPick: (suspend () -> BoardPicture?) -> Unit): () -> Unit {
    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) onPick { withContext(Dispatchers.IO) { runCatching { loadBoardPicture(context, uri) }.getOrNull() } }
    }
    return { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
}

/** Keep accepted originals; re-encode HEIC or oversized files as an oriented JPEG up to 2560 px. */
private fun loadBoardPicture(context: Context, uri: Uri): BoardPicture {
    val resolver = context.contentResolver
    val type = resolver.getType(uri) ?: "image/jpeg"
    val raw = resolver.openInputStream(uri)?.use { it.readBytes() } ?: error("unreadable")
    var w = 0
    var h = 0
    ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(raw))) { d, info, _ ->
        w = info.size.width
        h = info.size.height
        val s = 64f / maxOf(w, h)
        if (s < 1f) d.setTargetSize((w * s).toInt().coerceAtLeast(1), (h * s).toInt().coerceAtLeast(1))
    }
    if (w <= 0 || h <= 0) error("unreadable")
    if (type in PICTURE_TYPES && raw.size <= MAX_PICTURE_BYTES) return BoardPicture(type, raw, w, h)
    val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(raw))) { d, info, _ ->
        d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        val s = MAX_PICTURE_SIDE.toFloat() / maxOf(info.size.width, info.size.height)
        if (s < 1f) d.setTargetSize((info.size.width * s).toInt().coerceAtLeast(1), (info.size.height * s).toInt().coerceAtLeast(1))
    }
    val out = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.JPEG, 88, out)
    return BoardPicture("image/jpeg", out.toByteArray(), bitmap.width, bitmap.height)
}
