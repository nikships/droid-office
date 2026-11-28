package ai.factory.droidoffice.ui.theme.artwork

import ai.factory.droidoffice.core.BackdropMotion
import ai.factory.droidoffice.core.Glass
import ai.factory.droidoffice.core.WallpaperSource
import ai.factory.droidoffice.ui.theme.Palette
import android.content.res.Configuration
import android.graphics.BitmapFactory
import androidx.annotation.DrawableRes
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.toArgb
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.BiasAbsoluteAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.draw.BlurredEdgeTreatment
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp

private val grays = mutableMapOf<Int, Int>()

/** The artwork's bright gray (the web's `brightGray`), measured once per process off the main thread. */
@Composable
private fun artworkGray(@DrawableRes image: Int): Int? {
    val resources = LocalContext.current.resources
    // Keyed on the image: switching theme or orientation must not keep the previous picture's gray.
    val gray = remember(image) { mutableStateOf(grays[image]) }
    LaunchedEffect(image) {
        if (gray.value != null) return@LaunchedEffect
        gray.value = withContext(Dispatchers.Default) {
            val options = BitmapFactory.Options().apply { inSampleSize = 16 }
            val bitmap = BitmapFactory.decodeResource(resources, image, options) ?: return@withContext null
            val pixels = IntArray(bitmap.width * bitmap.height)
            bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
            bitmap.recycle()
            Glass.brightGray(pixels)
        }?.also { grays[image] = it }
    }
    return gray.value
}

internal fun artworkAnimates(systemScale: Float, composeScale: Float) = systemScale > 0f && composeScale > 0f

@Composable
internal fun artworkMotionEnabled(): Boolean {
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

@Composable
fun ArtworkBackdrop(theme: Artwork) {
    val look = Palette.look
    val full = Modifier.fillMaxSize()
    val config = LocalConfiguration.current
    val portrait = theme.phoneArt(config.orientation == Configuration.ORIENTATION_PORTRAIT, config.smallestScreenWidthDp)
    val chrome = Glass.chrome(theme.glass, look.glass)
    val picture = look.wallpaper == WallpaperSource.Artwork
    val image = portrait?.image ?: theme.image
    val gray = artworkGray(image)
    // Like the web's dim layer: the owner's dim, or the least shade that keeps text readable on clearer glass.
    val readable = if (gray == null) 0f else Glass.pictureShade(theme.glass, look.glass, theme.tint.toArgb(), theme.text.toArgb(), theme.muted.toArgb(), gray)
    val shade = if (picture) maxOf(theme.shade, look.dim.alpha, readable) else theme.shade
    Box(full.background(theme.bg)) {
        if (picture) Image(
            painterResource(image), null,
            if (look.blur.radiusDp > 0) full.blur(look.blur.radiusDp.dp, BlurredEdgeTreatment.Rectangle) else full,
            BiasAbsoluteAlignment((portrait?.focalX ?: theme.x) * 2 - 1, (portrait?.focalY ?: theme.y) * 2 - 1),
            ContentScale.Crop,
        )
        // Do not create a clock when motion is reduced, held Still or hidden by Solid glass; show the same frame on pause and cold start.
        val moving = artworkMotionEnabled() && look.motion == BackdropMotion.Live && chrome < 1f
        val time = if (moving) rememberInfiniteTransition(label = "artwork").animateFloat(
            0f, 600f, infiniteRepeatable(tween(600_000, easing = LinearEasing)), label = "seconds",
        ) else null
        Canvas(full.drawWithCache {
            val center = Offset(size.width * .5f, size.height * .4f)
            val radius = size.width * 1.2f
            val veil = Brush.radialGradient(0f to Color.Transparent, theme.veilStart to Color.Transparent, 1f to theme.veil, center = center, radius = radius)
            onDrawWithContent {
                drawContent()
                if (shade > 0f) drawRect(Color.Black, alpha = shade)
                if (radius > 0f && size.height > 0f) scale(1f, size.height * .9f / radius, center) { drawCircle(veil, radius, center) }
                // The thinnest (chrome) glass under text; individual panes add the remaining tint.
                drawRect(theme.tint, alpha = chrome)
            }
        }) { theme.stage(this, (time?.value ?: 0f) * theme.speed) }
    }
}
