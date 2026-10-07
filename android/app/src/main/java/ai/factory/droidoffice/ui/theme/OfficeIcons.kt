package ai.factory.droidoffice.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/**
 * The app's own line icons, drawn on a 24 grid with a 1.75 stroke so they sit with Geist's weight.
 * Material's core set covers the rest.
 */
object OfficeIcons {
    private fun icon(name: String, vararg strokes: String, fills: List<Pair<String, Float>> = emptyList()): ImageVector {
        val b = ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
        for (d in strokes) {
            b.addPath(
                pathData = PathParser().parsePathString(d).toNodes(),
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 1.75f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
        }
        for ((d, alpha) in fills) b.addPath(pathData = PathParser().parsePathString(d).toNodes(), fill = SolidColor(Color.Black), fillAlpha = alpha)
        return b.build()
    }

    private fun dot(cx: Float, cy: Float, r: Float) = "M${cx - r},${cy}a$r,$r 0 1,0 ${r * 2},0a$r,$r 0 1,0 ${-r * 2},0z"

    val Scan = icon(
        "Scan",
        "M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8", "M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8", "M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16", "M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16",
        "M7.5 7.5h3v3h-3z", "M13.5 13.5h3v3h-3z", "M13.5 7.5h3", "M7.5 13.5v3",
    )
    val Terminal = icon("Terminal", "M3.5 5.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z", "M7.5 9l3 3-3 3", "M12.5 15h4")
    val Wifi = icon("Wifi", "M2.5 8.8a14 14 0 0 1 19 0", "M5.6 12.2a9.5 9.5 0 0 1 12.8 0", "M8.8 15.6a5 5 0 0 1 6.4 0", fills = listOf(dot(12f, 19f, 1.3f) to 1f))
    val Tailscale = icon(
        "Tailscale",
        fills = listOf(
            dot(5f, 5f, 2.2f) to 0.35f, dot(12f, 5f, 2.2f) to 0.35f, dot(19f, 5f, 2.2f) to 0.35f,
            dot(5f, 12f, 2.2f) to 1f, dot(12f, 12f, 2.2f) to 1f, dot(19f, 12f, 2.2f) to 1f,
            dot(5f, 19f, 2.2f) to 0.35f, dot(12f, 19f, 2.2f) to 1f, dot(19f, 19f, 2.2f) to 0.35f,
        ),
    )
    val Globe = icon("Globe", "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z", "M3 12h18", "M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z")
    val PullRequest = icon(
        "PullRequest",
        "M6 3.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4z", "M6 15.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4z", "M6 8.2v7.6",
        "M18 15.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4z", "M18 15.8V9a2.5 2.5 0 0 0-2.5-2.5H12", "M14.5 4l-2.5 2.5 2.5 2.5",
    )
    val Branch = icon(
        "Branch",
        "M6 3.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4z", "M6 15.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4z", "M18 3.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4z",
        "M6 8.2v7.6", "M18 8.2c0 4.5-3.5 6.3-8.5 7.3",
    )
    val Bolt = icon("Bolt", fills = listOf("M13.2 2.5L4.8 13.4h6l-1.1 8.1 8.5-11.1h-6.1z" to 1f))
    val Paste = icon("Paste", "M8.5 4.5h-2a2 2 0 0 0-2 2v12.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V6.5a2 2 0 0 0-2-2h-2", "M9 3h6v3H9z", "M8.5 12h7", "M8.5 15.5h4.5")
    val Keyboard = icon("Keyboard", "M2.5 7a2 2 0 0 1 2-2h15a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z", "M6 9.5h.01", "M10 9.5h.01", "M14 9.5h.01", "M18 9.5h.01", "M6 12.5h.01", "M18 12.5h.01", "M8 15.5h8")
    val Moon = icon("Moon", "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z")
    val Layers = icon("Layers", "M12 3l9 5-9 5-9-5z", "M3 12.5l9 5 9-5", "M3 16.5l9 5 9-5")
    val ArrowUp = icon("ArrowUp", "M12 19.5V5", "M5.5 11.5L12 5l6.5 6.5")
    val Queue = icon("Queue", "M4 6.5h11", "M4 12h11", "M4 17.5h7", "M18.5 14.5v6", "M15.5 17.5h6")
    val Door = icon("Door", "M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16", "M3.5 21h17", "M14.5 12h.01")
    val External = icon("External", "M14 4h6v6", "M20 4l-8.5 8.5", "M18 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5.5")
    val Copy = icon("Copy", "M9 9h10a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 21h-9.5A1.5 1.5 0 0 1 8 19.5V10a1 1 0 0 1 1-1z", "M16 9V5.5A1.5 1.5 0 0 0 14.5 4H5.5A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8")
    val Building = icon("Building", "M4 21V4.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1V21", "M15 9h4a1 1 0 0 1 1 1v11", "M2.5 21h19", "M8 7.5h3", "M8 11h3", "M8 14.5h3")
    val Unplug = icon("Unplug", "M3 3l18 18", "M8.5 8.5L6 11a4.2 4.2 0 0 0 6 6l2.5-2.5", "M15.5 15.5L18 13a4.2 4.2 0 0 0-6-6L9.5 9.5", "M19 5l2-2", "M3 21l2-2")
    val Sparkle = icon("Sparkle", "M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z", "M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z")
    val Bell = icon("Bell", "M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z", "M10 20.5a2 2 0 0 0 4 0")
    val Link = icon("Link", "M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1", "M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1")
    val Shell = icon("Shell", "M4 17.5l5-5.5-5-5.5", "M11.5 18h8.5")
    val Agent = icon("Agent", "M7 7.5a5 5 0 0 1 10 0V12a5 5 0 0 1-10 0z", "M9.8 9.6h.01", "M14.2 9.6h.01", "M9.8 13a3 3 0 0 0 4.4 0", "M4.5 20.5a8.5 8.5 0 0 1 15 0", "M12 2.5v0")
}
