package ai.factory.droidoffice.ui.components

import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
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
fun BrandLogo(brand: String?, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val image = remember(brand, context) { brand?.let { OfficeIcons.model(context, it) } }
    val tint = when (brand) {
        "claude" -> Color(0xFFD97757)
        "gemini", "gemma" -> Color(0xFF8AB4F8)
        "deepseek", "glm", "meta", "muse" -> Color(0xFF6B91FF)
        "qwen" -> Color(0xFFA58BFA)
        "minimax" -> Color(0xFFFF6C88)
        "mistral" -> Color(0xFFFA7D32)
        "junie", "nvidia" -> Color(0xFF8ED453)
        "perplexity", "cohere" -> Color(0xFF67C9BD)
        "antigravity" -> Color(0xFF9CB5FF)
        else -> Palette.Text
    }
    Icon(image ?: OfficeIcons.Sparkle, null, modifier, tint = if (image == null) Palette.TextTertiary else tint)
}
