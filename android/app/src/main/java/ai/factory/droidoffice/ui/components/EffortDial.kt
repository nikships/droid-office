package ai.factory.droidoffice.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import ai.factory.droidoffice.core.Effort
import ai.factory.droidoffice.core.EffortDial
import kotlin.math.cos
import kotlin.math.sin

/** The effort dial, drawn on the web's 22 × 12.5 grid (src/shared/effort-dial.ts) scaled to [height]. */
@Composable
fun EffortDialMark(effort: Effort, modifier: Modifier = Modifier, height: Dp = 11.dp) {
    val color = Color(EffortDial.colors.getValue(effort))
    val sweep = 180f * EffortDial.fraction(effort)
    val label = EffortDial.label(effort)
    Canvas(modifier.size(width = height * (22f / 12.5f), height = height).semantics { contentDescription = label }) {
        val u = size.height / 12.5f
        val c = Offset(11f * u, 11f * u)
        fun along(deg: Float, r: Float): Offset {
            val a = Math.toRadians(deg.toDouble())
            return Offset(c.x + r * u * cos(a).toFloat(), c.y + r * u * sin(a).toFloat())
        }
        for (k in 0..5) drawLine(Color.White.copy(alpha = 0.28f), along(180f + k * 36f, 9.6f), along(180f + k * 36f, 10.6f), strokeWidth = 0.7f * u)
        val r = 8f * u
        val topLeft = Offset(c.x - r, c.y - r)
        val box = Size(r * 2, r * 2)
        drawArc(Color.White.copy(alpha = 0.13f), 180f, 180f, useCenter = false, topLeft = topLeft, size = box, style = Stroke(1.6f * u, cap = StrokeCap.Round))
        drawArc(color, 180f, sweep, useCenter = false, topLeft = topLeft, size = box, style = Stroke(1.6f * u, cap = StrokeCap.Round))
        drawLine(color, c, along(180f + sweep, 5f), strokeWidth = 1.1f * u, cap = StrokeCap.Round)
        drawCircle(Color(0xFFEDEDED), radius = 1.5f * u, center = c)
    }
}
