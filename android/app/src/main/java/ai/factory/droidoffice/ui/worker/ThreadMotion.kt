package ai.factory.droidoffice.ui.worker

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.ThreadStatus
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.ThreadPalette
import kotlinx.coroutines.delay
import kotlin.random.Random

/** The Factory app's transcript motion: its disclosure curve and timings, shimmer and status line. */
internal object ThreadMotion {
    /** cubic-bezier(0.22, 1, 0.36, 1), the curve Factory opens and closes every disclosure on. */
    val Ease = CubicBezierEasing(0.22f, 1f, 0.36f, 1f)
    const val OPEN_MS = 280
    const val CLOSE_MS = 200
    /** Chevrons turning, and a thought's label, quick as hover feedback. */
    const val TURN_MS = 150
    const val FADE_MS = 100
    /** A live thought's "Thinking" shimmer sweep. */
    const val THINKING_SHIMMER_MS = 2_000

    /** Opening: the height grows while what's inside fades up 8 dp from 98.5% (Factory blurs it too). */
    val open: EnterTransition =
        expandVertically(tween(OPEN_MS, easing = Ease), expandFrom = Alignment.Top) +
            fadeIn(tween(OPEN_MS, easing = Ease)) +
            slideInVertically(tween(OPEN_MS, easing = Ease)) { it.coerceAtMost(8) } +
            scaleIn(tween(OPEN_MS, easing = Ease), initialScale = 0.985f, transformOrigin = TransformOrigin(0f, 0f))

    val close: ExitTransition = shrinkVertically(tween(CLOSE_MS, easing = Ease), shrinkTowards = Alignment.Top) + fadeOut(tween(CLOSE_MS, easing = Ease))
}

/** 0 to 1 over [periodMs], forever. Read it only in the draw phase ([shimmer]) so nothing re-lays out. */
@Composable
internal fun rememberSweep(periodMs: Int): State<Float> =
    rememberInfiniteTransition(label = "sweep").animateFloat(0f, 1f, infiniteRepeatable(tween(periodMs, easing = LinearEasing)), label = "sweep")

/**
 * Text drawn in its own colour with a lighter band sweeping across it, as Factory's shimmer
 * gradients do: [span] is how many widths the gradient covers (2 for the status line, 4 for a thought).
 */
internal fun Modifier.shimmer(sweep: State<Float>, highlight: Color, base: Color, span: Float) =
    this.graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }.drawWithContent {
        drawContent()
        val w = size.width * span
        val x = -w + sweep.value * (size.width + w)
        drawRect(
            Brush.linearGradient(
                0f to base, 0.4f to base, 0.5f to highlight, 0.6f to base, 1f to base,
                start = Offset(x, 0f), end = Offset(x + w, 0f),
            ),
            blendMode = BlendMode.SrcIn,
        )
    }

/** "Thought for 4s" from the session's own time; a second at least, as Factory rounds it. */
internal fun seconds(ms: Long): String = "${maxOf(1L, ms / 1000)}s"

/**
 * A thought, as Factory's thinking block shows it: "Thinking for 3s" with "Thinking" shimmering while
 * the model is still on it, then "Thought for 4s" (or "Thought" when the session doesn't say how
 * long). Tapping opens the thought under it, at most 300 dp tall, on Factory's 280 ms curve.
 */
@Composable
internal fun ThinkingBlock(
    id: String,
    text: String,
    live: Boolean,
    open: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
    /** How long the model spent on it, from the session ([ai.factory.droidoffice.core.ThreadEntry.tookMs]). */
    tookMs: Long? = null,
    /** When a live thought started, from the office ([ai.factory.droidoffice.core.ThreadLive.phaseSince]); else when this phone first saw it. */
    startedAtMs: Long? = null,
    redacted: Boolean = false,
) {
    val reveal = rememberReveal()
    val seen = remember(id) { workerNowMillis() }
    var now by remember(id) { mutableLongStateOf(workerNowMillis()) }
    LaunchedEffect(id, live) {
        while (live) {
            now = workerNowMillis()
            delay(1_000)
        }
    }
    val duration = if (live) seconds(now - (startedAtMs ?: seen)) else tookMs?.let(::seconds)
    val label = when {
        live -> "Thinking for $duration"
        duration != null -> "Thought for $duration"
        else -> "Thought"
    }
    Column(modifier.fillMaxWidth().then(reveal.modifier).tagged(Tags.Worker.threadEntry(id))) {
        if (redacted) {
            Row(Modifier.heightIn(min = 28.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(OfficeIcons.Lock, null, Modifier.size(12.dp), tint = ThreadPalette.TextTertiary)
                Spacer(Modifier.width(8.dp))
                Text("Thinking content redacted by provider", style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, color = ThreadPalette.ToolLabel, fontStyle = androidx.compose.ui.text.font.FontStyle.Italic))
            }
            return@Column
        }
        val turn by animateFloatAsState(if (open) 90f else 0f, tween(ThreadMotion.TURN_MS), label = "chevron")
        Row(
            Modifier.clip(RoundedCornerShape(4.dp)).disclosure(open) {
                if (!open) reveal.ask()
                onToggle()
            }.clearAndSetSemantics {
                contentDescription = if (open) "Collapse $label" else "Expand $label"
                stateDescription = if (open) "Expanded" else "Collapsed"
                role = Role.Button
                onClick { onToggle(); true }
            }.tagged(Tags.Worker.threadToggle(id)).heightIn(min = 34.dp).padding(vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, lineHeight = 18.sp)
            if (live) {
                val sweep = rememberSweep(ThreadMotion.THINKING_SHIMMER_MS)
                Text("Thinking", style = style.copy(color = ThreadPalette.ToolLabel), modifier = Modifier.shimmer(sweep, ThreadPalette.Text, ThreadPalette.ToolLabel, span = 4f))
                Text(" for $duration", style = style.copy(color = ThreadPalette.TextTertiary))
            } else {
                Text(
                    buildAnnotatedString {
                        append("Thought")
                        if (duration != null) withStyle(SpanStyle(color = ThreadPalette.TextTertiary)) { append(" for $duration") }
                    },
                    style = style.copy(color = ThreadPalette.ToolLabel),
                )
            }
            Icon(
                OfficeIcons.Chevron, null,
                Modifier.padding(start = 6.dp).size(12.dp).graphicsLayer { rotationZ = turn },
                tint = ThreadPalette.TextTertiary,
            )
        }
        AnimatedVisibility(open, enter = ThreadMotion.open, exit = ThreadMotion.close) {
            Box(Modifier.fillMaxWidth().heightIn(max = 300.dp).verticalScroll(rememberScrollState()).padding(start = 12.dp, top = 2.dp, bottom = 4.dp)) {
                ThreadSelection {
                    Text(text, style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, lineHeight = 20.8.sp, color = ThreadPalette.TextTertiary))
                }
            }
        }
    }
}

/**
 * The line under a live turn, as Factory's droidStatusIndicator: a small spinner and a phrase for
 * what the turn is doing, shimmering, swapped for another every ten seconds with a fade out and in.
 * Every frame of it runs in the draw phase; only the swap recomposes.
 */
@Composable
internal fun StatusIndicator(mode: ThreadStatus.Mode, modifier: Modifier = Modifier) {
    if (mode == ThreadStatus.Mode.Idle) return
    var index by remember(mode) { mutableIntStateOf(ThreadStatus.pick(mode, -1, Random::nextInt)) }
    val alpha = remember(mode) { Animatable(0f) }
    LaunchedEffect(mode) {
        alpha.animateTo(1f, tween(ThreadStatus.FADE_MS))
        while (true) {
            delay(ThreadStatus.ROTATE_MS)
            if (ThreadStatus.phrases(mode).size <= 1) continue
            alpha.animateTo(0f, tween(ThreadStatus.FADE_MS))
            index = ThreadStatus.pick(mode, index, Random::nextInt)
            alpha.animateTo(1f, tween(ThreadStatus.FADE_MS))
        }
    }
    val phrase = ThreadStatus.phrases(mode).getOrElse(index) { "" }
    val sweep = rememberSweep(ThreadStatus.SHIMMER_MS)
    Row(
        modifier.fillMaxWidth().heightIn(min = 28.dp).clearAndSetSemantics {
            contentDescription = phrase
            liveRegion = LiveRegionMode.Polite
        }.tagged(Tags.Worker.THREAD_STATUS),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Spinner(Modifier.size(12.dp), ThreadPalette.TextSecondary)
        Spacer(Modifier.width(8.dp))
        Text(
            phrase,
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, lineHeight = 18.sp, color = ThreadPalette.TextSecondary),
            maxLines = 1,
            modifier = Modifier.graphicsLayer { this.alpha = alpha.value }.shimmer(sweep, ThreadPalette.Text, ThreadPalette.TextSecondary, span = 2f),
        )
    }
}
