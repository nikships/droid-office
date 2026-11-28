package ai.factory.droidoffice.ui.theme.artwork

import ai.factory.droidoffice.core.AppearanceLook
import ai.factory.droidoffice.core.BackdropMotion
import ai.factory.droidoffice.core.Glass
import ai.factory.droidoffice.core.GlassLevel
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.WallpaperBlur
import ai.factory.droidoffice.core.WallpaperDim
import ai.factory.droidoffice.core.WallpaperSource
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.Palette
import android.os.Build
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

private val GlassCardWidth = 96.dp
private val GlassCardGap = 8.dp

internal fun glassNote(level: GlassLevel) = when (level) {
    GlassLevel.Crystal -> "Ultra-clear glass. The artwork shows sharply through the header and panes."
    GlassLevel.Clear -> "Light, airy glass that keeps the artwork clearly visible."
    GlassLevel.Tinted -> "A balanced translucent tint over the artwork."
    GlassLevel.Frosted -> "Tinted glass over the artwork."
    GlassLevel.Smoked -> "Deep glass that turns bright artwork into a quiet glow."
    GlassLevel.Solid -> "Opaque panels. The artwork is hidden."
}

internal fun wallpaperNote(source: WallpaperSource) = when (source) {
    WallpaperSource.Artwork -> "The theme’s full-resolution artwork."
    WallpaperSource.None -> "No picture: the theme’s color and lighting show behind the glass."
}

internal fun motionNote(motion: BackdropMotion, systemAnimates: Boolean) = when {
    !systemAnimates -> "Held still because Android animations are off."
    motion == BackdropMotion.Still -> "The backdrop holds one still frame."
    else -> "The backdrop’s light moves."
}

/**
 * Glass, wallpaper and motion options for the active artwork, below the theme list. [change] edits
 * the stored look, so quick taps on different options never undo each other.
 */
@Composable
internal fun AppearanceOptions(theme: Artwork, look: AppearanceLook, change: ((AppearanceLook) -> AppearanceLook) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = 14.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Section("Glass", glassNote(look.glass)) {
            val scroll = rememberScrollState()
            val step = with(LocalDensity.current) { (GlassCardWidth + GlassCardGap).roundToPx() }
            val cardWidth = with(LocalDensity.current) { GlassCardWidth.roundToPx() }
            // Keep the chosen level in view (Smoked and Solid sit past the edge of a phone), including after Restore.
            LaunchedEffect(look.glass) {
                val start = look.glass.ordinal * step
                val viewport = scroll.viewportSize
                if (viewport > 0 && start >= scroll.value && start + cardWidth <= scroll.value + viewport) return@LaunchedEffect
                scroll.animateScrollTo((start - step).coerceAtLeast(0))
            }
            Row(
                Modifier.fillMaxWidth().horizontalScroll(scroll).selectableGroup(),
                horizontalArrangement = Arrangement.spacedBy(GlassCardGap),
            ) {
                for (level in GlassLevel.entries) GlassCard(theme, level, level == look.glass, look.wallpaper == WallpaperSource.Artwork) { change { it.copy(glass = level) } }
            }
        }
        Section("Wallpaper", wallpaperNote(look.wallpaper)) {
            Segments("Wallpaper", WallpaperSource.entries, look.wallpaper, { it.label }, { Tags.Artwork.wallpaper(it.id) }) { picked -> change { it.copy(wallpaper = picked) } }
            if (look.wallpaper == WallpaperSource.Artwork) {
                SubLabel("Dim", "Darkens the picture behind the glass. Clearer glass may already add some shade.")
                Segments("Dim", WallpaperDim.entries, look.dim, { it.label }, { Tags.Artwork.dim(it.id) }) { picked -> change { it.copy(dim = picked) } }
                // Compose's blur needs Android 12; below it the option would save but change nothing.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    SubLabel("Blur", "Softens the picture behind the glass.")
                    Segments("Blur", WallpaperBlur.entries, look.blur, { it.label }, { Tags.Artwork.blur(it.id) }) { picked -> change { it.copy(blur = picked) } }
                }
            }
        }
        Section("Motion", motionNote(look.motion, artworkMotionEnabled())) {
            Segments("Motion", BackdropMotion.entries, look.motion, { it.label }, { Tags.Artwork.motion(it.id) }) { picked -> change { it.copy(motion = picked) } }
        }
        TextButton({ change { AppearanceLook() } }, Modifier.tagged(Tags.Artwork.RESET), enabled = !look.isDefault) {
            Text("Restore default options", color = if (look.isDefault) Palette.TextTertiary else Palette.Text)
        }
    }
}

@Composable
private fun Section(title: String, note: String, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Column {
            Eyebrow(title)
            Text(note, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 4.dp))
        }
        content()
    }
}

@Composable
private fun SubLabel(title: String, note: String) {
    Column(Modifier.padding(top = 4.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall)
        Text(note, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun <T> Segments(group: String, options: List<T>, selected: T, label: (T) -> String, tag: (T) -> String, pick: (T) -> Unit) {
    val outer = RoundedCornerShape(10.dp)
    val inner = RoundedCornerShape(7.dp)
    Row(Modifier.fillMaxWidth().clip(outer).background(Palette.Surface).border(1.dp, Palette.Border, outer).padding(3.dp).selectableGroup()) {
        for (option in options) {
            val on = option == selected
            Box(
                Modifier.weight(1f).heightIn(min = 40.dp).clip(inner).background(if (on) Palette.AccentMuted else Palette.Surface)
                    .border(1.dp, if (on) Palette.Accent else Palette.Surface, inner)
                    // Every tap goes to the store: the selection shown may lag a tap still being saved.
                    .selectable(on, role = Role.RadioButton) { pick(option) }.semantics { contentDescription = "$group: ${label(option)}" }.tagged(tag(option)),
                contentAlignment = Alignment.Center,
            ) {
                Text(label(option), style = MaterialTheme.typography.labelLarge, color = if (on) Palette.Text else Palette.TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** The artwork on the left, the level's pane over it on the right, as the web's glass cards. */
@Composable
private fun GlassCard(theme: Artwork, level: GlassLevel, selected: Boolean, picture: Boolean, pick: () -> Unit) {
    val shape = RoundedCornerShape(10.dp)
    Column(
        Modifier.width(GlassCardWidth).clip(shape).background(Palette.Surface).border(1.dp, if (selected) theme.accent else Palette.BorderStrong, shape)
            .selectable(selected, role = Role.RadioButton, onClick = pick).tagged(Tags.Artwork.glass(level.id)),
    ) {
        Box(Modifier.fillMaxWidth().height(56.dp).background(theme.bg)) {
            if (picture) Image(painterResource(theme.preview), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            Column(
                Modifier.fillMaxHeight().fillMaxWidth(.62f).align(Alignment.CenterEnd).background(theme.tint.copy(alpha = Glass.pane(theme.glass, level)))
                    .padding(horizontal = 8.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Spacer(Modifier.fillMaxWidth().height(4.dp).background(theme.text.copy(alpha = .7f), RoundedCornerShape(2.dp)))
                Spacer(Modifier.fillMaxWidth(.6f).height(4.dp).background(theme.text.copy(alpha = .45f), RoundedCornerShape(2.dp)))
            }
        }
        Column(Modifier.padding(horizontal = 8.dp, vertical = 6.dp)) {
            Text(level.label, style = MaterialTheme.typography.labelLarge, color = if (selected) Palette.Text else Palette.TextSecondary, maxLines = 1)
            Text(level.hint, style = MaterialTheme.typography.labelSmall, color = Palette.TextTertiary, maxLines = 1)
        }
    }
}
