package ai.factory.droidoffice.core

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Options layered on an artwork theme, matching the web companion's Settings → Appearance
 * (`src/shared/companion-themes.ts`, `src/client/ui/companion-theme.ts`). Original ignores them.
 */
enum class GlassLevel(val id: String, val label: String, val hint: String) {
    Crystal("crystal", "Crystal", "No tint"),
    Clear("clear", "Clear", "Light tint"),
    Tinted("tinted", "Tinted", "Balanced"),
    Frosted("frosted", "Frosted", "Classic"),
    Smoked("smoked", "Smoked", "Deep tint"),
    Solid("solid", "Solid", "Opaque"),
    ;

    companion object {
        val Default = Frosted
        fun parse(id: String?) = entries.find { it.id == id } ?: Default
    }
}

enum class WallpaperSource(val id: String, val label: String) {
    Artwork("theme", "Artwork"),
    None("none", "None"),
    ;

    companion object {
        fun parse(id: String?) = entries.find { it.id == id } ?: Artwork
    }
}

/** The extra black laid over the picture (`DIM_ALPHA` on the web). */
enum class WallpaperDim(val id: String, val label: String, val alpha: Float) {
    None("none", "None", 0f),
    Low("low", "Low", .2f),
    Medium("medium", "Medium", .4f),
    High("high", "High", .6f),
    ;

    companion object {
        fun parse(id: String?) = entries.find { it.id == id } ?: None
    }
}

/** Blur radius on the picture in dp (`BLUR_PX` on the web, CSS px). */
enum class WallpaperBlur(val id: String, val label: String, val radiusDp: Int) {
    None("none", "None", 0),
    Soft("soft", "Soft", 12),
    Strong("strong", "Strong", 32),
    ;

    companion object {
        fun parse(id: String?) = entries.find { it.id == id } ?: None
    }
}

enum class BackdropMotion(val id: String, val label: String) {
    Live("live", "Live"),
    Still("still", "Still"),
    ;

    companion object {
        fun parse(id: String?) = entries.find { it.id == id } ?: Live
    }
}

data class AppearanceLook(
    val glass: GlassLevel = GlassLevel.Default,
    val wallpaper: WallpaperSource = WallpaperSource.Artwork,
    val dim: WallpaperDim = WallpaperDim.None,
    val blur: WallpaperBlur = WallpaperBlur.None,
    val motion: BackdropMotion = BackdropMotion.Live,
) {
    val isDefault get() = this == AppearanceLook()
}

/** The web's `glassAlpha` and `chromeAlpha`: pane and chrome opacity from the theme's default pane opacity. */
object Glass {
    private class Spec(val delta: Float, val min: Float, val max: Float, val chromeGap: Float, val chromeMin: Float)

    private val specs = mapOf(
        GlassLevel.Crystal to Spec(-.54f, .16f, .34f, .06f, .1f),
        GlassLevel.Clear to Spec(-.4f, .28f, .48f, .08f, .2f),
        GlassLevel.Tinted to Spec(-.22f, .44f, .66f, .1f, .34f),
        GlassLevel.Frosted to Spec(0f, .3f, 1f, .1f, .3f),
        GlassLevel.Smoked to Spec(.14f, .82f, .94f, .06f, .76f),
    )

    private fun round3(v: Float) = (v * 1000f).roundToInt() / 1000f

    fun pane(themeGlass: Float, level: GlassLevel): Float {
        val spec = specs[level] ?: return 1f
        return round3(min(spec.max, max(spec.min, themeGlass + spec.delta)))
    }

    fun chrome(themeGlass: Float, level: GlassLevel): Float {
        val spec = specs[level] ?: return 1f
        return round3(max(spec.chromeMin, pane(themeGlass, level) - spec.chromeGap))
    }

    /** The alpha a pane needs over the full-screen chrome layer so the two composite to [pane]. */
    fun paneOverChrome(themeGlass: Float, level: GlassLevel): Float {
        val chrome = chrome(themeGlass, level)
        if (chrome >= 1f) return 0f
        return ((pane(themeGlass, level) - chrome) / (1f - chrome)).coerceIn(0f, 1f)
    }

    /** The strongest shade a picture needs: enough to keep text readable over a white one. */
    const val MAX_PICTURE_SHADE = .9f

    private fun linear(c: Float): Double {
        val s = c / 255.0
        return if (s <= .03928) s / 12.92 else Math.pow((s + .055) / 1.055, 2.4)
    }

    private fun luminance(r: Float, g: Float, b: Float) = .2126 * linear(r) + .7152 * linear(g) + .0722 * linear(b)
    private fun luminance(argb: Int) = luminance((argb shr 16 and 255).toFloat(), (argb shr 8 and 255).toFloat(), (argb and 255).toFloat())
    private fun ratio(x: Double, y: Double) = (max(x, y) + .05) / (min(x, y) + .05)

    /**
     * The web's `pictureShade`: the least black veil over a picture whose bright areas are [gray]
     * (0–255) that keeps [text] at 7:1 and [muted] at 4.5:1 on the thinnest (chrome) glass. Colors are ARGB.
     */
    fun pictureShade(themeGlass: Float, level: GlassLevel, tint: Int, text: Int, muted: Int, gray: Int): Float {
        val alpha = chrome(themeGlass, level)
        val textY = luminance(text)
        val mutedY = luminance(muted)
        val tr = (tint shr 16 and 255) * alpha
        val tg = (tint shr 8 and 255) * alpha
        val tb = (tint and 255) * alpha
        fun readable(shade: Float): Boolean {
            val v = gray.coerceIn(0, 255) * (1 - shade) * (1 - alpha)
            val ground = luminance(tr + v, tg + v, tb + v)
            return ratio(textY, ground) >= 7 && ratio(mutedY, ground) >= 4.5
        }
        if (readable(0f)) return 0f
        var lo = 0f
        var hi = MAX_PICTURE_SHADE
        while (hi - lo > .005f) {
            val mid = (lo + hi) / 2
            if (readable(mid)) hi = mid else lo = mid
        }
        return kotlin.math.ceil(hi * 100f) / 100f
    }

    /** The web's `brightGray`: the [quantile] of the pixels' luminance as one gray level, from opaque ARGB pixels. */
    fun brightGray(pixels: IntArray, quantile: Float = .9f): Int {
        if (pixels.isEmpty()) return 0
        val ys = DoubleArray(pixels.size) { i ->
            val p = pixels[i]
            (p ushr 24) / 255.0 * luminance(p)
        }
        ys.sort()
        val y = ys[min(ys.size - 1, (ys.size * quantile).toInt())]
        return (255 * (if (y <= .00304) y * 12.92 else 1.055 * Math.pow(y, 1 / 2.4) - .055)).roundToInt()
    }
}
