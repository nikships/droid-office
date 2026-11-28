package ai.factory.droidoffice.ui.theme

import ai.factory.droidoffice.R
import android.graphics.BitmapFactory
import android.os.Build
import androidx.annotation.DrawableRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.SemanticsPropertyReceiver
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight

typealias DrawableId = Int
internal val supportsWallpaperBlur get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
internal const val reducedMotionNote = "Held still because Android animations are off."

@Composable internal fun officePainter(@DrawableRes id: DrawableId) = painterResource(id)

private val modelMarks = mutableMapOf<String, ImageBitmap>()
@Composable internal fun modelMark(brand: String): ImageBitmap {
    val assets = LocalContext.current.assets
    return modelMarks.getOrPut(brand) { assets.open("model-icons/$brand.png").use { BitmapFactory.decodeStream(it).asImageBitmap() } }
}

private fun variable(res: Int, weight: Int) = Font(res, FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))
val Geist = FontFamily((300..800 step 100).map { variable(R.font.geist, it) })
val GeistMono = FontFamily((400..700 step 100).map { variable(R.font.geist_mono, it) })

internal fun SemanticsPropertyReceiver.automationTag(name: String) {
    testTagsAsResourceId = true
    testTag = name
}
