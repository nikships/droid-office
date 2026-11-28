package ai.factory.droidoffice.ui.theme.artwork

import ai.factory.droidoffice.ui.theme.DrawableId
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope

data class TerminalInk(val foreground: String, val cursor: String, val background: String, val selection: String)

/** Cover alignment as fractions: 0 is left/top, .5 is centered, 1 is right/bottom. */
data class PortraitArt(val image: DrawableId, val focalX: Float, val focalY: Float)

/** The stage gets theme-scaled seconds. Draw over the image, beneath the dim and elliptical veil. */
data class Artwork(
    val id: String,
    val name: String,
    val blurb: String,
    val image: DrawableId,
    val preview: DrawableId,
    val x: Float, val y: Float,
    val bg: Color, val tint: Color, val text: Color, val muted: Color,
    val accent: Color, val accent2: Color, val line: Color, val glass: Float,
    val terminal: TerminalInk,
    val speed: Float,
    val stage: DrawScope.(Float) -> Unit,
    val shade: Float = 0f,
    val veilStart: Float = .55f,
    val veil: Color = Color.Black.copy(alpha = .55f),
    val portrait: PortraitArt? = null,
) {
    internal fun phoneArt(isPortrait: Boolean, smallestWidthDp: Int) =
        portrait?.takeIf { isPortrait && smallestWidthDp in 1 until 600 }
}

object Artworks {
    // Slots follow the source gallery order. Each port owns its own file, never this list.
    val all = listOfNotNull(CarbonsCopy, NightlyOrbit, NeoTokyo, KyotoFirefly, OrbitalFoundry, AbyssalBiolume, AstralCathedral, SakuraMist)
    fun find(id: String?) = all.find { it.id == id }
}
