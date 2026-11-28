package ai.factory.droidoffice.data

import ai.factory.droidoffice.core.AppearanceLook
import ai.factory.droidoffice.core.BackdropMotion
import ai.factory.droidoffice.core.GlassLevel
import ai.factory.droidoffice.core.WallpaperBlur
import ai.factory.droidoffice.core.WallpaperDim
import ai.factory.droidoffice.core.WallpaperSource
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.stringPreferencesKey

/** No key is the original Android look, including on installations predating the gallery. */
internal object ArtworkPreference {
    val key = stringPreferencesKey("artwork_theme")
    fun write(p: MutablePreferences, id: String?) {
        if (id == null) p.remove(key) else p[key] = id
    }
}

/** Glass, wallpaper and motion options; a missing or unknown value reads as the default. */
internal object AppearancePreference {
    val glass = stringPreferencesKey("appearance_glass")
    val wallpaper = stringPreferencesKey("appearance_wallpaper")
    val dim = stringPreferencesKey("appearance_dim")
    val blur = stringPreferencesKey("appearance_blur")
    val motion = stringPreferencesKey("appearance_motion")

    fun read(p: Preferences) = AppearanceLook(
        glass = GlassLevel.parse(p[glass]),
        wallpaper = WallpaperSource.parse(p[wallpaper]),
        dim = WallpaperDim.parse(p[dim]),
        blur = WallpaperBlur.parse(p[blur]),
        motion = BackdropMotion.parse(p[motion]),
    )

    fun write(p: MutablePreferences, look: AppearanceLook) {
        val defaults = AppearanceLook()
        fun put(key: Preferences.Key<String>, value: String, default: String) {
            if (value == default) p.remove(key) else p[key] = value
        }
        put(glass, look.glass.id, defaults.glass.id)
        put(wallpaper, look.wallpaper.id, defaults.wallpaper.id)
        put(dim, look.dim.id, defaults.dim.id)
        put(blur, look.blur.id, defaults.blur.id)
        put(motion, look.motion.id, defaults.motion.id)
    }
}
