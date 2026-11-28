package ai.factory.droidoffice.ui.theme.artwork

import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.SecondaryButton
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ArtworkPickerButton() {
    val store = LocalGraph.current.store
    val active = Palette.artwork
    val scope = rememberCoroutineScope()
    var open by rememberSaveable { mutableStateOf(false) }
    SecondaryButton("Appearance", { open = true }, Modifier.fillMaxWidth().padding(top = 10.dp).tagged(Tags.Artwork.OPEN), icon = OfficeIcons.Sparkle)
    if (!open) return
    ModalBottomSheet(
        onDismissRequest = { open = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Palette.Bg, modifier = Modifier.tagged(Tags.Artwork.PICKER),
    ) {
        LazyColumn(
            Modifier.fillMaxWidth().selectableGroup(), contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Eyebrow("This device", color = Palette.Accent)
                        Text("Appearance", style = MaterialTheme.typography.headlineMedium)
                    }
                    TextButton({ open = false }, Modifier.tagged(Tags.Artwork.CLOSE)) { Text("Done") }
                }
                Text(if (active == null) "Choose a look for this companion." else "Choose a look for this companion. Glass, wallpaper and motion are below the themes.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 4.dp, bottom = 6.dp))
            }
            items(listOf(null) + Artworks.all, key = { it?.id ?: "default" }) { theme ->
                ArtworkChoice(theme, theme == active) { scope.launch { store.settings { it.copy(artworkId = theme?.id) } } }
            }
            // Original has no backdrop or glass, so its options stay hidden rather than disabled.
            if (active != null) item(key = "options") {
                AppearanceOptions(active, Palette.look) { edit -> scope.launch { store.settings { it.copy(look = edit(it.look)) } } }
            }
        }
    }
}

@Composable
private fun ArtworkChoice(theme: Artwork?, selected: Boolean, choose: () -> Unit) {
    val accent = theme?.accent ?: Color(0xFFEE6018)
    val shape = RoundedCornerShape(12.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(Palette.Surface).border(1.dp, if (selected) accent else Palette.BorderStrong, shape)
            .selectable(selected, role = Role.RadioButton, onClick = choose).tagged(Tags.Artwork.choice(theme?.id ?: "default")),
    ) {
        Box(Modifier.fillMaxWidth().height(72.dp).background(Color(0xFF020202))) {
            if (theme != null) Image(painterResource(theme.preview), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            Row(Modifier.align(Alignment.BottomStart).padding(10.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                for (color in listOf(accent, theme?.accent2 ?: Color.White, theme?.tint ?: Color.DarkGray)) {
                    Spacer(Modifier.size(10.dp).background(color, CircleShape).border(1.dp, Color.White.copy(alpha = .26f), CircleShape))
                }
            }
        }
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(theme?.name ?: "Original", style = MaterialTheme.typography.titleMedium)
                Text(theme?.blurb ?: "OLED black and Factory orange.", style = MaterialTheme.typography.bodySmall)
            }
            RadioButton(selected, onClick = null, modifier = Modifier.padding(start = 12.dp), colors = RadioButtonDefaults.colors(selectedColor = accent))
        }
    }
}
