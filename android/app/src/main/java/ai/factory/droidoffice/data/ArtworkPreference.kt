package ai.factory.droidoffice.data

import ai.factory.droidoffice.core.AppearanceLook
import ai.factory.droidoffice.core.BackdropMotion
import ai.factory.droidoffice.core.GlassLevel
import ai.factory.droidoffice.core.WallpaperBlur
import ai.factory.droidoffice.core.WallpaperDim
import ai.factory.droidoffice.core.WallpaperSource

/** No key is the original Android look, including on installations predating the gallery. */
internal object ArtworkPreference {
    const val key = "artwork_theme"
    fun write(p: MutableMap<String, String>, id: String?) {
        if (id == null) p.remove(key) else p[key] = id
    }
}

/** Glass, wallpaper and motion options; a missing or unknown value reads as the default. */
internal object AppearancePreference {
    private const val glass = "appearance_glass"
    private const val wallpaper = "appearance_wallpaper"
    private const val dim = "appearance_dim"
    private const val blur = "appearance_blur"
    private const val motion = "appearance_motion"

    fun read(p: Map<String, String>) = AppearanceLook(
        glass = GlassLevel.parse(p[glass]),
        wallpaper = WallpaperSource.parse(p[wallpaper]),
        dim = WallpaperDim.parse(p[dim]),
        blur = WallpaperBlur.parse(p[blur]),
        motion = BackdropMotion.parse(p[motion]),
    )

    fun write(p: MutableMap<String, String>, look: AppearanceLook) {
        val defaults = AppearanceLook()
        fun put(key: String, value: String, default: String) {
            if (value == default) p.remove(key) else p[key] = value
        }
        put(glass, look.glass.id, defaults.glass.id)
        put(wallpaper, look.wallpaper.id, defaults.wallpaper.id)
        put(dim, look.dim.id, defaults.dim.id)
        put(blur, look.blur.id, defaults.blur.id)
        put(motion, look.motion.id, defaults.motion.id)
    }
}
