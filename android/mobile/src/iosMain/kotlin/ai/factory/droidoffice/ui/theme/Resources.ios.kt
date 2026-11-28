@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package ai.factory.droidoffice.ui.theme

import ai.factory.droidoffice.R
import ai.factory.droidoffice.data.toBytes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.semantics.SemanticsPropertyReceiver
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.platform.Font
import androidx.compose.ui.unit.dp
import org.jetbrains.skia.Image
import platform.Foundation.NSBundle
import platform.Foundation.NSData
import platform.Foundation.dataWithContentsOfFile

typealias DrawableId = String
internal const val supportsWallpaperBlur = true
internal const val reducedMotionNote = "Held still because Reduce Motion is on."

private fun bytes(path: String): ByteArray {
    val data = checkNotNull(NSData.dataWithContentsOfFile("${NSBundle.mainBundle.resourcePath}/$path")) { "Missing bundled resource: $path" }
    return data.toBytes()
}

internal fun bundledBitmap(path: String) = Image.makeFromEncoded(bytes(path)).toComposeImageBitmap()
private val glyph by lazy {
    ImageVector.Builder("Factory", 24.dp, 24.dp, 21.42f, 21.42f).apply {
        addGroup(translationX = .96f, translationY = 1.47f)
        addPath(PathParser().parsePathString(R.glyphPath).toNodes(), pathFillType = PathFillType.EvenOdd, fill = SolidColor(Color.White))
        clearGroup()
    }.build()
}

@Composable internal fun officePainter(id: DrawableId): Painter = if (id == R.drawable.ic_glyph) rememberVectorPainter(glyph) else remember(id) { BitmapPainter(bundledBitmap(id)) }
@Composable internal fun modelMark(brand: String) = remember(brand) { bundledBitmap("assets/model-icons/$brand.png") }

private fun variable(file: String, weights: IntProgression): FontFamily {
    val data by lazy { bytes("font/$file.ttf") }
    return FontFamily(weights.map { Font("$file-$it", { data }, FontWeight(it), variationSettings = FontVariation.Settings(FontVariation.weight(it))) })
}
val Geist = variable("geist", 300..800 step 100)
val GeistMono = variable("geist_mono", 400..700 step 100)

internal fun SemanticsPropertyReceiver.automationTag(name: String) { testTag = name }
