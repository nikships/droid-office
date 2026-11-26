package ai.factory.droidoffice.ui.theme.artwork

import android.content.res.Configuration
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
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource

internal fun artworkAnimates(systemScale: Float, composeScale: Float) = systemScale > 0f && composeScale > 0f

@Composable
private fun artworkMotionEnabled(): Boolean {
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
    val full = Modifier.fillMaxSize()
    val config = LocalConfiguration.current
    val portrait = theme.phoneArt(config.orientation == Configuration.ORIENTATION_PORTRAIT, config.smallestScreenWidthDp)
    Box(full.background(theme.bg)) {
        Image(
            painterResource(portrait?.image ?: theme.image), null, full,
            BiasAbsoluteAlignment((portrait?.focalX ?: theme.x) * 2 - 1, (portrait?.focalY ?: theme.y) * 2 - 1),
            ContentScale.Crop,
        )
        // Do not create a clock when motion is reduced; show the same frame on pause and cold start.
        val time = if (artworkMotionEnabled()) rememberInfiniteTransition(label = "artwork").animateFloat(
            0f, 600f, infiniteRepeatable(tween(600_000, easing = LinearEasing)), label = "seconds",
        ) else null
        Canvas(full.drawWithCache {
            val center = Offset(size.width * .5f, size.height * .4f)
            val radius = size.width * 1.2f
            val veil = Brush.radialGradient(0f to Color.Transparent, theme.veilStart to Color.Transparent, 1f to theme.veil, center = center, radius = radius)
            onDrawWithContent {
                drawContent()
                if (theme.shade > 0f) drawRect(Color.Black, alpha = theme.shade)
                if (radius > 0f && size.height > 0f) scale(1f, size.height * .9f / radius, center) { drawCircle(veil, radius, center) }
                // The thinnest (chrome) glass under text; individual panes add the remaining tint.
                drawRect(theme.tint, alpha = theme.glass - .1f)
            }
        }) { theme.stage(this, (time?.value ?: 0f) * theme.speed) }
    }
}
