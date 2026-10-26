package ai.factory.droidoffice.ui.components

import androidx.compose.material3.Icon
import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.platform.LocalContext
import ai.factory.droidoffice.core.ModelBrand
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette

/** Adjacent text names the model. Logos are decorative and bundled in the APK, including offline. */
@Composable
fun ModelLogo(id: String? = null, name: String? = null, provider: String? = null, modifier: Modifier = Modifier) {
    BrandLogo(ModelBrand.of(id, name, provider), modifier)
}

@Composable
fun BrandLogo(brand: String?, modifier: Modifier = Modifier, monoTint: Color = Palette.Text) {
    val context = LocalContext.current
    val image = remember(brand, context) { brand?.let { OfficeIcons.model(context, it) } }
    if (image == null) Icon(OfficeIcons.Sparkle, null, modifier, tint = Palette.TextTertiary)
    else Image(image, null, modifier, colorFilter = if (brand in ModelBrand.monochrome) ColorFilter.tint(monoTint) else null)
}
