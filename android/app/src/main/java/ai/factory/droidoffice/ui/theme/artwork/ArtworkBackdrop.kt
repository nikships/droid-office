package ai.factory.droidoffice.ui.theme.artwork

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
import androidx.compose.runtime.getValue
import androidx.compose.ui.BiasAbsoluteAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource

@Composable
fun ArtworkBackdrop(theme: Artwork) {
    val full = Modifier.fillMaxSize()
    Box(full.background(theme.bg)) {
        Image(painterResource(theme.image), null, full, BiasAbsoluteAlignment(theme.x * 2 - 1, theme.y * 2 - 1), ContentScale.Crop)
        val time by rememberInfiniteTransition(label = "artwork").animateFloat(
            0f, 600f, infiniteRepeatable(tween(600_000, easing = LinearEasing)), label = "seconds",
        )
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
        }) { theme.stage(this, time * theme.speed) }
    }
}
