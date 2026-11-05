package ai.factory.droidoffice.ui.components

import androidx.compose.material3.Icon
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import ai.factory.droidoffice.R
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.platform.LocalContext
import ai.factory.droidoffice.core.ModelBrand
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.core.Workers
import ai.factory.droidoffice.net.ModelCatalogue
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette

/** Adjacent text names the model. Logos are decorative and bundled in the APK, including offline. */
@Composable
fun ModelLogo(id: String? = null, name: String? = null, provider: String? = null, modifier: Modifier = Modifier) {
    BrandLogo(ModelBrand.of(id, name, provider), modifier)
}

/**
 * Every worker surface resolves the active model against the same catalogue entry. A model DroidProxy
 * serves wears the pinwheel on its corner, ringed in [behind] (the surface it sits on), as on the web.
 */
@Composable
fun WorkerModelLogo(worker: WorkerInfo, catalogue: ModelCatalogue?, modifier: Modifier = Modifier, behind: Color = Palette.Surface) {
    if (worker.isShell) return
    val id = Workers.modelId(worker) ?: return
    val model = catalogue?.models?.firstOrNull { it.id == id }
    if (!ModelBrand.viaDroidProxy(id, model?.displayName)) return ModelLogo(id, model?.displayName, model?.provider, modifier)
    Box(modifier) {
        ModelLogo(id, model?.displayName, model?.provider, Modifier.matchParentSize())
        Box(Modifier.align(Alignment.BottomEnd).offset(4.dp, 4.dp).size(10.dp).clip(CircleShape).background(behind), contentAlignment = Alignment.Center) {
            Icon(painterResource(R.drawable.ic_glyph), null, Modifier.size(8.dp), tint = Palette.Text)
        }
    }
}

@Composable
fun BrandLogo(brand: String?, modifier: Modifier = Modifier, monoTint: Color = Palette.Text) {
    val context = LocalContext.current
    val image = remember(brand, context) { brand?.let { OfficeIcons.model(context, it) } }
    if (image == null) Icon(OfficeIcons.Sparkle, null, modifier, tint = Palette.TextTertiary)
    else Image(image, null, modifier, colorFilter = if (brand in ModelBrand.monochrome) ColorFilter.tint(monoTint) else null)
}
