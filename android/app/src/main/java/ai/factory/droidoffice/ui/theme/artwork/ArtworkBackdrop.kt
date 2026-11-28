package ai.factory.droidoffice.ui.theme.artwork

import ai.factory.droidoffice.core.BackdropMotion
import ai.factory.droidoffice.core.Glass
import ai.factory.droidoffice.core.WallpaperSource
import ai.factory.droidoffice.ui.theme.Palette
import ai.factory.droidoffice.ui.theme.officePainter
import androidx.compose.ui.graphics.toArgb
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
import androidx.compose.ui.BiasAbsoluteAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.BlurredEdgeTreatment
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.unit.dp

internal fun artworkAnimates(systemScale: Float, composeScale: Float) = systemScale > 0f && composeScale > 0f

@Composable
fun ArtworkBackdrop(theme: Artwork) = ArtworkLayer {
    val look = Palette.look
    val full = Modifier.fillMaxSize()
    val window = LocalWindowInfo.current.containerDpSize
    val portrait = theme.phoneArt(window.height > window.width, minOf(window.width, window.height).value.toInt())
    val chrome = Glass.chrome(theme.glass, look.glass)
    val picture = look.wallpaper == WallpaperSource.Artwork
    val image = portrait?.image ?: theme.image
    val gray = artworkGray(image)
    // Like the web's dim layer: the owner's dim, or the least shade that keeps text readable on clearer glass.
    val readable = if (gray == null) 0f else Glass.pictureShade(theme.glass, look.glass, theme.tint.toArgb(), theme.text.toArgb(), theme.muted.toArgb(), gray)
    val shade = if (picture) maxOf(theme.shade, look.dim.alpha, readable) else theme.shade
    Box(full.background(theme.bg)) {
        if (picture) Image(
            officePainter(image), null,
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
