package ai.factory.droidoffice.ui.theme.artwork

import ai.factory.droidoffice.core.Glass
import android.database.ContentObserver
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.annotation.DrawableRes
import androidx.compose.runtime.*
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable internal inline fun ArtworkLayer(content: @Composable () -> Unit) = content()

private val grays = mutableMapOf<Int, Int>()

@Composable internal fun artworkGray(@DrawableRes image: Int): Int? {
    val resources = LocalContext.current.resources
    var gray by remember(image) { mutableStateOf(grays[image]) }
    LaunchedEffect(image) {
        if (gray != null) return@LaunchedEffect
        gray = withContext(Dispatchers.Default) {
            val options = BitmapFactory.Options().apply { inSampleSize = 16 }
            val bitmap = BitmapFactory.decodeResource(resources, image, options) ?: return@withContext null
            val pixels = IntArray(bitmap.width * bitmap.height)
            bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
            bitmap.recycle()
            Glass.brightGray(pixels)
        }?.also { grays[image] = it }
    }
    return gray
}

@Composable internal fun artworkMotionEnabled(): Boolean {
    val resolver = LocalContext.current.contentResolver
    val key = Settings.Global.ANIMATOR_DURATION_SCALE
    fun readScale() = Settings.Global.getFloat(resolver, key, 1f)
    var systemScale by remember(resolver) { mutableFloatStateOf(readScale()) }
    DisposableEffect(resolver) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) { systemScale = readScale() }
        }
        resolver.registerContentObserver(Settings.Global.getUriFor(key), false, observer)
        systemScale = readScale()
        onDispose { resolver.unregisterContentObserver(observer) }
    }
    val composeScale = rememberCoroutineScope().coroutineContext[MotionDurationScale]?.scaleFactor ?: 1f
    return artworkAnimates(systemScale, composeScale)
}
