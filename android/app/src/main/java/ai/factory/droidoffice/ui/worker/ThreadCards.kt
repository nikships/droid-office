package ai.factory.droidoffice.ui.worker

import ai.factory.droidoffice.core.ActivePlan
import ai.factory.droidoffice.core.ActivityState
import ai.factory.droidoffice.core.DiffLineKind
import ai.factory.droidoffice.core.FileChangeKind
import ai.factory.droidoffice.core.Markdown
import ai.factory.droidoffice.core.PlanStep
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.ThreadBlock
import ai.factory.droidoffice.core.ThreadCardKind
import ai.factory.droidoffice.core.ThreadDiffLine
import ai.factory.droidoffice.core.ThreadEntry
import ai.factory.droidoffice.core.ThreadFileChange
import ai.factory.droidoffice.core.ThreadModelAction
import ai.factory.droidoffice.core.ThreadRow
import ai.factory.droidoffice.core.ThreadSegment
import ai.factory.droidoffice.core.ThreadTurnChanges
import ai.factory.droidoffice.core.ThreadView
import ai.factory.droidoffice.core.ToolCards
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.ThreadPalette
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

// The app's V3 transcript tokens (index.css core-v2 dark, toolContainer constants in the bundle).
/** --core-v2-transcript-tool-label: a row's icon and verb. */
private val ToolLabel get() = ThreadPalette.TextSecondary
/** --core-v2-text-tertiary: what a row acted on, and muted end labels. */
private val ToolDetail get() = ThreadPalette.TextTertiary
/** --core-v2-border-inner: the open content's frame. */
private val ToolBorder get() = ThreadPalette.BorderStrong
private val Ease = CubicBezierEasing(0.22f, 1f, 0.36f, 1f)
/** A group closing on its own while the thread follows the bottom sheds its height evenly. */
private val EaseInOut = CubicBezierEasing(0.45f, 0f, 0.55f, 1f)
private const val OPEN_MS = 280
private const val CLOSE_MS = 200
private const val SHIMMER_MS = 2000
private const val PROGRESS_HINT_MS = 15_000L
/** Rows bleed this far past the column on each side so their text lines up with the prose. */
private val BLEED = 6.dp
private val ROW_MIN = 34.dp
private val DENSE_MIN = 28.dp
/** The open content's cap (300 - the 34 header), and the cap of a diff or command output inside it. */
private val CONTENT_MAX = 266.dp
private val OUTPUT_MAX = 200.dp
/** Seven dense rows before a summary group's rows scroll. */
private val GROUP_MAX = DENSE_MIN * 7
private val GROUP_FADE = 36.dp
private const val OUTPUT_CHARS = 20_000

private val Rounded4 = RoundedCornerShape(4.dp)

/** What every row in an Activity reads from. */
private class Cards(
    val open: SnapshotStateMap<String, Boolean>,
    val loaded: Map<String, ThreadEntry>,
    val asking: Boolean,
    val allWorkers: List<WorkerInfo>,
    val deskWorker: (String) -> WorkerInfo?,
    val onOpenWorker: ((String) -> Unit)?,
    val floorDir: String?,
    val onFlip: (String, Boolean) -> Unit,
    val live: ((String) -> ToolCards.Live?)?,
    val livePhaseSince: Long?,
)

/**
 * Everything the worker did between two messages, as the app's transcript draws it: exploration
 * folds into one summary row, while commands, file changes, subagents and other tools are flat rows
 * that open in place. [live] gives a running tool's output from the office's live layer.
 */
@Composable
internal fun Activity(
    a: ThreadRow.Activity,
    open: SnapshotStateMap<String, Boolean>,
    loaded: Map<String, ThreadEntry>,
    asking: Boolean,
    allWorkers: List<WorkerInfo>,
    deskWorker: (String) -> WorkerInfo?,
    onOpenWorker: ((String) -> Unit)?,
    floorDir: String?,
    onToggleExploration: (ThreadView.Segment.Exploration, Boolean) -> Unit,
    onFlip: (String, Boolean) -> Unit,
    live: ((String) -> ToolCards.Live?)? = null,
    livePhaseSince: Long? = null,
) {
    val first = a.id.removePrefix("activity:")
    val cards = Cards(open, loaded, asking, allWorkers, deskWorker, onOpenWorker, floorDir, onFlip, live, livePhaseSince)
    Column(Modifier.fillMaxWidth().tagged(Tags.Worker.threadGroup(first))) {
        if (a.segments.isNotEmpty()) Segments(a, cards) else Legacy(a, cards, onToggleExploration)
        a.turnChanges?.let { TurnChanges(a.id, it, floorDir, Modifier.padding(top = 8.dp)) }
    }
}

@Composable
private fun Segments(a: ThreadRow.Activity, c: Cards) {
    val blocks = remember(a) { a.blocks.associateBy { it.id } }
    val actions = remember(a) {
        a.blocks.filterIsInstance<ThreadBlock.Tools>().flatMap { b -> b.actions.map { it.id to (b to it) } }.toMap()
    }
    for (seg in a.segments) key(seg.id) {
        when (seg) {
            is ThreadSegment.Explore -> {
                val isOpen = c.open[seg.id] ?: seg.open
                val anyOpen = seg.actionIds.any { c.open[it] == true } || seg.blockIds.any { c.open[it] == true }
                SummaryGroup(
                    action = seg.action, details = seg.details, live = seg.live && !c.asking, isOpen = isOpen,
                    onToggle = { c.onFlip(seg.id, isOpen) },
                    toggleTag = Tags.Worker.threadGroupToggle(seg.id), summaryTag = Tags.Worker.threadGroupSummary(seg.id),
                    capped = !anyOpen, follows = seg.live,
                ) {
                    for (id in seg.blockIds) {
                        when (val b = blocks[id]) {
                            is ThreadBlock.Thought -> ThoughtRow(b, c)
                            is ThreadBlock.Tools -> {
                                for (act in b.actions) if (seg.actionIds.isEmpty() || act.id in seg.actionIds) ActionRow(act, c, dense = true)
                                b.plan?.let { PlanList(it, working = false, Modifier.padding(vertical = 4.dp).tagged(Tags.Worker.threadRunPlan(b.id.removePrefix("tools:")))) }
                            }
                            null -> Unit
                        }
                    }
                }
            }
            is ThreadSegment.Thought -> (blocks[seg.blockId] as? ThreadBlock.Thought)?.let { ThoughtRow(it, c) }
            is ThreadSegment.Tool -> actions[seg.actionId]?.let { (b, act) -> Tool(b, act, c, nested = false) }
            is ThreadSegment.Repeat -> {
                val isOpen = c.open[seg.id] ?: seg.open
                SummaryGroup(
                    action = seg.summaries.joinToString(" → "), details = if (seg.times == 1) "1 time" else "${seg.times} times",
                    live = seg.live && !c.asking, isOpen = isOpen, onToggle = { c.onFlip(seg.id, isOpen) },
                    toggleTag = Tags.Worker.threadCardGroupToggle(seg.id), tag = Tags.Worker.threadCardGroup(seg.id),
                    capped = false, follows = seg.live,
                ) {
                    for (id in seg.actionIds) actions[id]?.let { (b, act) -> Tool(b, act, c, nested = true) }
                }
            }
            is ThreadSegment.Tasks -> {
                val isOpen = c.open[seg.id] ?: seg.open
                val (verb, rest) = ToolCards.splitSummary(seg.label)
                SummaryGroup(
                    action = verb, details = rest, live = seg.live && !c.asking, isOpen = isOpen, onToggle = { c.onFlip(seg.id, isOpen) },
                    toggleTag = Tags.Worker.threadCardGroupToggle(seg.id), tag = Tags.Worker.threadCardGroup(seg.id),
                    capped = false, follows = seg.live,
                    end = {
                        if (seg.failed > 0) Text("${seg.failed} failed", style = endStyle().copy(color = ThreadPalette.Danger))
                        Text("${seg.settled}/${seg.actionIds.size}", style = endStyle())
                    },
                ) {
                    for (id in seg.actionIds) actions[id]?.let { (b, act) -> Tool(b, act, c, nested = true) }
                }
            }
        }
    }
}

/** An office that sends only blocks and groups: its exploration and cards in the same rows. */
@Composable
private fun Legacy(a: ThreadRow.Activity, c: Cards, onToggleExploration: (ThreadView.Segment.Exploration, Boolean) -> Unit) {
    val items = remember(a) { ThreadView.items(a, ThreadView.segments(a)) }
    @Composable
    fun SegmentView(seg: ThreadView.Segment) {
        when (seg) {
            is ThreadView.Segment.Exploration -> {
                val isOpen = ThreadView.Open.exploration(seg, a.open, c.open)
                val (verb, rest) = ToolCards.splitSummary(seg.label)
                val working = seg.live && !c.asking
                val anyOpen = seg.sourceIds.any { c.open[it] == true }
                SummaryGroup(
                    action = verb, details = rest, live = working, isOpen = isOpen,
                    onToggle = { onToggleExploration(seg, a.open) },
                    toggleTag = Tags.Worker.threadGroupToggle(seg.tagId), summaryTag = Tags.Worker.threadGroupSummary(seg.tagId),
                    capped = !anyOpen, follows = seg.live,
                    end = seg.status?.let { s -> { Text(s, style = endStyle(), maxLines = 1, modifier = Modifier.tagged(Tags.Worker.threadGroupStatus(seg.tagId))) } },
                    under = seg.running?.let { r ->
                        {
                            Text(
                                r, style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, color = ToolDetail), maxLines = 1, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.padding(bottom = 2.dp).semantics { liveRegion = LiveRegionMode.Polite }.tagged(Tags.Worker.threadGroupRunning(seg.tagId)),
                            )
                        }
                    },
                ) {
                    for (block in seg.blocks) {
                        when (block) {
                            is ThreadBlock.Thought -> ThoughtRow(block, c)
                            is ThreadBlock.Tools -> {
                                for (action in block.actions) ActionRow(action, c, dense = true)
                                block.plan?.let { PlanList(it, working = false, Modifier.padding(vertical = 4.dp).tagged(Tags.Worker.threadRunPlan(block.id.removePrefix("tools:")))) }
                            }
                        }
                    }
                }
            }
            is ThreadView.Segment.Card -> for (action in seg.block.actions) Tool(seg.block, action, c, nested = false)
        }
    }
    for (item in items) {
        when (item) {
            is ThreadView.Item.One -> SegmentView(item.segment)
            is ThreadView.Item.Group -> {
                val g = item.group
                val isOpen = ThreadView.Open.group(g, c.open)
                val tag = g.id.removePrefix("group:tools:")
                val (verb, rest) = ToolCards.splitSummary(g.label)
                SummaryGroup(
                    action = verb, details = rest, live = g.live && a.live && !c.asking, isOpen = isOpen, onToggle = { c.onFlip(g.id, isOpen) },
                    toggleTag = Tags.Worker.threadCardGroupToggle(tag), tag = Tags.Worker.threadCardGroup(tag),
                    capped = false, follows = false,
                    end = if (g.files > 0) ({ DiffCounts(g.additions, g.deletions) }) else null,
                ) {
                    for (seg in item.segments) SegmentView(seg)
                }
            }
        }
    }
}

/** One tool call as its own row, by what it is. */
@Composable
private fun Tool(block: ThreadBlock.Tools, action: ThreadModelAction, c: Cards, nested: Boolean) {
    when (action.card ?: block.card) {
        ThreadCardKind.Change -> {
            val changes = action.changes
            if (changes.isNullOrEmpty()) ActionRow(action, c, dense = nested)
            else Column(Modifier.fillMaxWidth().tagged(Tags.Worker.threadEntry(action.id))) {
                changes.forEachIndexed { idx, change ->
                    val changeKey = if (changes.size == 1) action.id else "${action.id}:$idx"
                    FileChangeRow(action, change, changeKey, single = changes.size == 1, c = c, nested = nested)
                }
            }
        }
        ThreadCardKind.Command -> CommandRow(action, c, nested)
        ThreadCardKind.Delegate -> DelegationRow(action, c, nested)
        null -> ActionRow(action, c, dense = nested)
    }
    block.plan?.let { PlanList(it, working = false, Modifier.padding(vertical = 4.dp).tagged(Tags.Worker.threadRunPlan(block.id.removePrefix("tools:")))) }
}

// --- The row (toolContainer) -------------------------------------------------------------------

@Composable
private fun toolStyle(): TextStyle = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp, lineHeight = 18.sp, letterSpacing = (-0.12).sp, fontWeight = FontWeight.Normal)

@Composable
private fun endStyle(): TextStyle = LocalOfficeType.current.monoBody.copy(fontSize = 11.sp, lineHeight = 14.sp, color = ToolDetail)

/** A verb in the tool-label colour and what it acted on in the tertiary one, on one line. */
private fun toolLine(verb: String, subject: String?, verbColor: Color = ToolLabel): AnnotatedString = buildAnnotatedString {
    withStyle(SpanStyle(color = verbColor)) { append(verb) }
    if (!subject.isNullOrBlank()) {
        if (verb.isNotEmpty()) append(' ')
        withStyle(SpanStyle(color = ToolDetail)) { append(subject.replace('\n', ' ')) }
    }
}

/** Lets the row run [x] past its column on each side, so the text inside its padding lines up with the column. */
private fun Modifier.bleed(x: Dp) = this.layout { m, c ->
    if (!c.hasBoundedWidth) {
        val p = m.measure(c)
        return@layout layout(p.width, p.height) { p.place(0, 0) }
    }
    val px = x.roundToPx()
    val w = c.maxWidth + px * 2
    val p = m.measure(c.copy(minWidth = w, maxWidth = w))
    layout(c.maxWidth, p.height) { p.place(-px, 0) }
}

private fun Modifier.tagIf(tag: String?) = if (tag == null) this else this.tagged(tag)

/** The sweep across a working row's words: two seconds, linear, forever. Null while it isn't working. */
@Composable
private fun rememberSweep(on: Boolean): State<Float>? {
    if (!on) return null
    val t = rememberInfiniteTransition(label = "shimmer")
    return t.animateFloat(0f, 1f, infiniteRepeatable(tween(SHIMMER_MS, easing = LinearEasing)), label = "sweep")
}

/**
 * The app's loading shimmer: a band of the primary text colour crossing the words left to right
 * (a 400% gradient from 100% to 0%). Drawn over the text only, in the draw phase.
 */
private fun Modifier.shimmer(sweep: State<Float>?): Modifier = if (sweep == null) this else this
    .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
    .drawWithContent {
        drawContent()
        val w = size.width
        val center = -w + 3f * w * sweep.value
        drawRect(
            Brush.horizontalGradient(listOf(Color.Transparent, ThreadPalette.Text, Color.Transparent), startX = center - 0.6f * w, endX = center + 0.6f * w),
            blendMode = BlendMode.SrcAtop,
        )
    }

@Composable
private fun Chevron(open: Boolean, modifier: Modifier = Modifier) {
    val turn = animateFloatAsState(if (open) 90f else 0f, tween(150), label = "chevron")
    Icon(OfficeIcons.Chevron, null, modifier.size(12.dp).graphicsLayer { rotationZ = turn.value }, tint = ToolDetail)
}

/** Opens like the app's tool content: height and a short rise with a fade in 280 ms, out in 200 ms. */
@Composable
private fun Disclosed(open: Boolean, closeEasing: Easing = Ease, content: @Composable () -> Unit) {
    val rise = with(LocalDensity.current) { 8.dp.roundToPx() }
    AnimatedVisibility(
        visible = open,
        enter = expandVertically(tween(OPEN_MS, easing = Ease), expandFrom = Alignment.Top) +
            fadeIn(tween(OPEN_MS, easing = Ease)) +
            slideInVertically(tween(OPEN_MS, easing = Ease)) { rise },
        exit = shrinkVertically(tween(CLOSE_MS, easing = closeEasing), shrinkTowards = Alignment.Top) +
            fadeOut(tween(CLOSE_MS, easing = closeEasing)) +
            slideOutVertically(tween(CLOSE_MS, easing = closeEasing)) { rise },
    ) { content() }
}

/**
 * A tool row: no frame while closed, a 14 dp icon, the line (verb and subject), the chevron right
 * after it, and an end label or controls at the far end. Its content opens under it in [ToolBox].
 */
@Composable
private fun ToolRow(
    glyph: ToolCards.Glyph?,
    line: AnnotatedString,
    working: Boolean,
    isOpen: Boolean,
    onToggle: (() -> Unit)?,
    modifier: Modifier = Modifier,
    toggleTag: String? = null,
    dense: Boolean = false,
    lineWeighted: Boolean = true,
    inline: (@Composable RowScope.() -> Unit)? = null,
    endLabel: String? = null,
    end: (@Composable RowScope.() -> Unit)? = null,
    content: (@Composable () -> Unit)? = null,
) {
    val reveal = rememberReveal()
    val sweep = rememberSweep(working)
    val canOpen = onToggle != null && content != null
    Column(modifier.fillMaxWidth().then(reveal.modifier)) {
        Row(
            Modifier.bleed(BLEED).clip(Rounded4)
                .then(
                    if (canOpen) {
                        Modifier.disclosure(isOpen) {
                            if (!isOpen) reveal.ask()
                            onToggle()
                        }
                    } else Modifier,
                )
                .tagIf(toggleTag)
                .heightIn(min = if (dense) DENSE_MIN else ROW_MIN)
                .padding(horizontal = BLEED, vertical = if (dense) 0.dp else 3.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (glyph != null) Icon(ToolIcons.of(glyph), null, Modifier.size(14.dp), tint = ToolLabel)
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    line, style = toolStyle().copy(color = ToolLabel), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = (if (lineWeighted) Modifier.weight(1f, fill = false) else Modifier).shimmer(sweep),
                )
                inline?.invoke(this)
                if (canOpen) Chevron(isOpen)
            }
            if (endLabel != null && !isOpen) Text(endLabel, style = endStyle(), maxLines = 1)
            end?.invoke(this)
        }
        if (content != null) {
            Disclosed(isOpen) {
                Column(Modifier.fillMaxWidth().padding(top = 2.dp, bottom = 6.dp)) { content() }
            }
        }
    }
}

/** The open content's frame: surface, inner border, 4 dp corners, scrolling past [CONTENT_MAX]. */
@Composable
private fun ToolBox(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val scroll = rememberScrollState()
    Column(
        modifier.bleed(BLEED).clip(Rounded4).background(ThreadPalette.Surface).border(1.dp, ToolBorder, Rounded4)
            .heightIn(max = CONTENT_MAX).verticalScroll(scroll),
        content = content,
    )
}

// --- Summary groups (toolCallSummaryGroup) -----------------------------------------------------

/**
 * Several tools under one line: the verb in the tool-label colour, what it covered in the tertiary
 * one. Rows sit right under it, capped at seven before they scroll with fading edges; while [follows]
 * the newest row stays in view.
 */
@Composable
private fun SummaryGroup(
    action: String,
    details: String,
    live: Boolean,
    isOpen: Boolean,
    onToggle: () -> Unit,
    toggleTag: String?,
    capped: Boolean,
    follows: Boolean,
    tag: String? = null,
    summaryTag: String? = null,
    end: (@Composable RowScope.() -> Unit)? = null,
    under: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val reveal = rememberReveal()
    val sweep = rememberSweep(live)
    val closesItself = remember { mutableStateOf(live) }
    if (live) closesItself.value = true
    Column(Modifier.fillMaxWidth().then(reveal.modifier).tagIf(tag)) {
        Row(
            Modifier.bleed(BLEED).clip(Rounded4).disclosure(isOpen) {
                if (!isOpen) reveal.ask()
                closesItself.value = false
                onToggle()
            }.tagIf(toggleTag).semantics { contentDescription = "${if (isOpen) "Collapse" else "Expand"} $action $details".trim() }
                .heightIn(min = ROW_MIN).padding(horizontal = BLEED, vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    toolLine(action, details), style = toolStyle().copy(color = ToolLabel), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false).shimmer(sweep).tagIf(summaryTag),
                )
                Chevron(isOpen)
            }
            end?.invoke(this)
        }
        under?.invoke()
        Disclosed(isOpen, closeEasing = if (closesItself.value) EaseInOut else Ease) {
            if (capped) Capped(follows) { Column(Modifier.fillMaxWidth().padding(bottom = 4.dp)) { content() } }
            else Column(Modifier.fillMaxWidth().padding(bottom = 4.dp)) { content() }
        }
    }
}

@Composable
private fun Capped(follows: Boolean, content: @Composable () -> Unit) {
    val scroll = rememberScrollState()
    LaunchedEffect(follows) {
        if (follows) snapshotFlow { scroll.maxValue }.collect { scroll.scrollTo(it) }
    }
    Box(
        Modifier.fillMaxWidth().heightIn(max = GROUP_MAX).drawWithContent {
            drawContent()
            val fade = GROUP_FADE.toPx().coerceAtMost(size.height / 2)
            if (scroll.value > 0) {
                drawRect(Brush.verticalGradient(listOf(ThreadPalette.Bg.copy(alpha = 0.9f), Color.Transparent), startY = 0f, endY = fade), size = Size(size.width, fade))
            }
            if (scroll.value < scroll.maxValue) {
                drawRect(
                    Brush.verticalGradient(listOf(Color.Transparent, ThreadPalette.Bg.copy(alpha = 0.9f)), startY = size.height - fade, endY = size.height),
                    topLeft = Offset(0f, size.height - fade), size = Size(size.width, fade),
                )
            }
        },
    ) {
        Column(Modifier.fillMaxWidth().verticalScroll(scroll)) { content() }
    }
}

// --- Rows by tool ------------------------------------------------------------------------------

@Composable
private fun ActionRow(a: ThreadModelAction, c: Cards, dense: Boolean) {
    val isOpen = ThreadView.Open.action(a, c.open)
    val (verb, subject) = ToolCards.words(a)
    ToolRow(
        glyph = ToolCards.glyph(a),
        line = remember(verb, subject) { toolLine(verb, subject) },
        working = a.state == ActivityState.Working,
        isOpen = isOpen,
        onToggle = { c.onFlip(a.id, isOpen) },
        modifier = Modifier.tagged(Tags.Worker.threadEntry(a.id)),
        toggleTag = Tags.Worker.threadToggle(a.id),
        dense = dense,
        endLabel = ToolCards.endLabel(a) ?: a.status.takeIf { it.isNotEmpty() },
    ) {
        ToolBox { ActionDetailsBody(a, c.loaded[a.id], Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) }
    }
}

/** One thought, with the shell's Factory timing, shimmer and disclosure motion. */
@Composable
private fun ThoughtRow(t: ThreadBlock.Thought, c: Cards) {
    val isOpen = ThreadView.Open.block(t, c.open)
    val entry = c.loaded[t.id]
    ThinkingBlock(
        id = t.id,
        text = ThreadView.thought(t, entry),
        live = t.live,
        open = isOpen,
        onToggle = { c.onFlip(t.id, isOpen) },
        tookMs = entry?.tookMs,
        startedAtMs = c.livePhaseSince,
    )
}

@Composable
private fun CommandRow(a: ThreadModelAction, c: Cards, nested: Boolean) {
    val entry = c.loaded[a.id]
    val working = a.state == ActivityState.Working
    val live = if (working) c.live?.invoke(a.id) else null
    val isOpen = ThreadView.Open.action(a, c.open)
    val command = a.command?.command?.takeIf { it.isNotBlank() }
        ?: a.arguments?.text(entry?.input)?.takeIf { it.isNotBlank() }
        ?: a.detail.orEmpty()
    val title = ToolCards.commandTitle(a.command?.summary)
    val output = live?.output ?: entry?.let { ThreadView.outputText(it, pictures = false) }
    val line = remember(title, nested) { if (nested) toolLine("Ran", title) else toolLine(title, null) }
    ToolRow(
        glyph = ToolCards.Glyph.Terminal,
        line = line,
        working = working,
        isOpen = isOpen,
        onToggle = { c.onFlip(a.id, isOpen) },
        modifier = Modifier.tagged(Tags.Worker.threadEntry(a.id)),
        toggleTag = Tags.Worker.threadToggle(a.id),
        dense = nested,
        inline = if (working && !isOpen) ({ ProgressHint() }) else null,
        endLabel = when (a.state) {
            ActivityState.Failed -> a.failedLabel ?: "Command failed"
            else -> ToolCards.endLabel(a)
        },
        end = if (isOpen) {
            {
                DisableSelection {
                    CopyActionChip(
                        label = "Copy command output",
                        textToCopy = ToolCards.commandCopy(command, output),
                        clipTitle = "Command",
                        tag = Tags.Worker.threadCommandCopy(a.id),
                        iconOnly = true,
                    )
                }
            }
        } else null,
    ) {
        ToolBox {
            val moreKey = "output:" + a.id
            val expanded = c.open[moreKey] == true
            Clamp(OUTPUT_MAX, expanded, onExpand = { c.onFlip(moreKey, false) }, label = "Expand command output", tag = Tags.Worker.threadMore(a.id)) {
                ThreadSelection {
                    Text(
                        remember(command, output, working, entry == null, live?.more) { commandText(command, output, working, loaded = entry != null || live != null, more = live?.more ?: 0) },
                        style = LocalOfficeType.current.monoBody.copy(fontSize = 11.sp, lineHeight = 17.sp),
                        modifier = Modifier.fillMaxWidth().padding(start = 10.dp, end = 12.dp, top = 3.dp, bottom = 3.dp),
                    )
                }
            }
            val pictures = entry?.images.orEmpty()
            if (pictures.isNotEmpty() && LocalPictureSource.current != null) {
                Box(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) { ThreadPictures(pictures, a.title, a.detail, end = false) }
            }
        }
    }
}

/** The command after a dim `$`, highlighted as Bash, then its output with blank and prompt lines dim. */
private fun commandText(command: String, output: String?, working: Boolean, loaded: Boolean, more: Int): AnnotatedString = buildAnnotatedString {
    if (command.isNotBlank()) {
        withStyle(SpanStyle(color = ToolDetail)) { append("$ ") }
        for (tok in Markdown.tokenizeCode(command.trim(), "sh")) {
            withStyle(SpanStyle(color = tokenColor(tok.kind, ThreadPalette.TextSecondary))) { append(tok.text) }
        }
    }
    fun dim(s: String) {
        if (length > 0) append('\n')
        withStyle(SpanStyle(color = ToolDetail)) { append(s) }
    }
    when {
        output.isNullOrEmpty() && working -> dim(ToolCards.WAITING_FOR_OUTPUT)
        output == null && !loaded -> dim(ThreadView.NOT_LOADED)
        output.isNullOrEmpty() -> Unit
        else -> {
            val clipped = output.length > OUTPUT_CHARS
            for (l in ToolCards.outputLines(if (clipped) output.take(OUTPUT_CHARS) else output)) {
                if (length > 0) append('\n')
                withStyle(SpanStyle(color = if (l.dim) ToolDetail else ThreadPalette.TextSecondary)) { append(l.text.ifEmpty { " " }) }
            }
            if (more > 0) dim("... and $more more ${if (more == 1) "line" else "lines"}")
            if (clipped) dim("Showing the first $OUTPUT_CHARS of ${output.length} characters. Raw TTY has the rest.")
        }
    }
}

private fun tokenColor(kind: Markdown.TokenKind, plain: Color): Color = when (kind) {
    Markdown.TokenKind.Plain -> plain
    Markdown.TokenKind.Keyword -> ThreadPalette.AccentHover
    Markdown.TokenKind.Type -> ThreadPalette.Info
    Markdown.TokenKind.String -> ThreadPalette.Success
    Markdown.TokenKind.Number -> ThreadPalette.Warning
    Markdown.TokenKind.Comment -> ThreadPalette.TextTertiary
}

/** "Tap to see progress", fading in once a command has run for 15 seconds (Click to see progress). */
@Composable
private fun ProgressHint() {
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        delay(PROGRESS_HINT_MS)
        shown = true
    }
    val rise = with(LocalDensity.current) { 4.dp.roundToPx() }
    AnimatedVisibility(shown, enter = fadeIn(tween(180)) + slideInVertically(tween(180)) { rise }) {
        Text(
            "Tap to see progress", style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp, color = ToolDetail), maxLines = 1,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
    }
}

/**
 * Shows [content] up to [max] tall, with a fade to the surface and a chevron over its foot that
 * shows the rest; nothing extra when it fits.
 */
@Composable
private fun Clamp(max: Dp, expanded: Boolean, onExpand: () -> Unit, label: String, tag: String, content: @Composable () -> Unit) {
    var overflows by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth()) {
        Box(
            Modifier.fillMaxWidth().clipToBounds().layout { m, cs ->
                val p = m.measure(cs.copy(maxHeight = Constraints.Infinity))
                val limit = max.roundToPx()
                val over = p.height > limit
                if (over != overflows) overflows = over
                layout(p.width, if (expanded || !over) p.height else limit) { p.place(0, 0) }
            },
        ) { content() }
        if (overflows && !expanded) {
            Box(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(63.dp)
                    .background(Brush.verticalGradient(listOf(Color.Transparent, ThreadPalette.Surface)))
                    .clickable(onClickLabel = label, role = Role.Button, onClick = onExpand)
                    .tagged(tag),
            ) {
                Icon(OfficeIcons.Chevron, label, Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp).size(12.dp).graphicsLayer { rotationZ = 90f }, tint = ThreadPalette.TextSecondary)
            }
        }
    }
}

@Composable
private fun FileChangeRow(action: ThreadModelAction, change: ThreadFileChange, changeKey: String, single: Boolean, c: Cards, nested: Boolean) {
    val preview = LocalFilePreview.current
    val isOpen = ThreadView.Open.change(changeKey, change, c.open)
    val relPath = remember(change.path, c.floorDir) { ThreadView.workspacePath(change.path, c.floorDir) }
    val usable = action.state != ActivityState.Failed && change.kind != FileChangeKind.Deleted
    val openAt: ((Int?) -> Unit)? = if (preview != null && relPath != null && usable) {
        { line -> preview.openFilePreview(relPath, line) }
    } else null
    val name = ToolCards.baseName(change.path)
    val verb = action.verb?.takeIf { single && it.isNotBlank() } ?: ToolCards.changeLabel(change.kind, change.additions, change.deletions)
    val deliverable = openAt != null && change.kind == FileChangeKind.Added && action.state == ActivityState.Complete && ThreadView.deliverable(change.path)
    ToolRow(
        glyph = if (action.icon == "patch") ToolCards.Glyph.Patch else ToolCards.changeGlyph(change.kind),
        line = remember(verb) { toolLine(verb, null) },
        working = action.state == ActivityState.Working,
        isOpen = isOpen,
        onToggle = { c.onFlip(changeKey, isOpen) },
        modifier = Modifier.tagged(Tags.Worker.threadChange(changeKey)),
        toggleTag = Tags.Worker.threadToggle(changeKey),
        dense = nested,
        lineWeighted = false,
        inline = {
            NamePill(
                name, onClick = openAt?.let { { it(ThreadView.targetLine(change)) } }, label = "Open $name",
                tag = Tags.Worker.threadChangeOpen(changeKey), modifier = Modifier.weight(1f, fill = false),
            )
            if (change.additions > 0 || change.deletions > 0) DiffCounts(change.additions, change.deletions, divided = true)
        },
        endLabel = if (action.state == ActivityState.Failed) action.failedLabel ?: ToolCards.changeError(change.kind) else ToolCards.endLabel(action),
        end = when {
            deliverable -> ({ PreviewChip("Preview $name", Tags.Worker.threadChangePreview(changeKey)) { openAt(null) } })
            openAt != null -> ({ RowIcon(ToolIcons.ArrowRight, "Open $name in Files") { openAt(ThreadView.targetLine(change)) } })
            else -> null
        },
    ) {
        ToolBox {
            when {
                change.lines.isNotEmpty() -> DiffBody(change, changeKey, c, openAt)
                action.state == ActivityState.Failed -> ActionDetailsBody(action, c.loaded[action.id], Modifier.padding(horizontal = 10.dp, vertical = 8.dp))
                else -> Text(
                    if (change.generated) "Generated file updated." else "No diff available",
                    style = MaterialTheme.typography.bodySmall.copy(color = ThreadPalette.TextSecondary),
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                )
            }
        }
    }
}

/** A file's name in the row's detail pill; tapping it opens the file. */
@Composable
private fun NamePill(name: String, onClick: (() -> Unit)?, label: String, tag: String, modifier: Modifier = Modifier) {
    Text(
        name,
        style = toolStyle().copy(fontSize = 12.sp, lineHeight = 16.sp, color = ThreadPalette.TextSecondary),
        maxLines = 1, overflow = TextOverflow.Ellipsis,
        modifier = modifier.clip(Rounded4).background(ThreadPalette.SurfaceHover)
            .then(if (onClick != null) Modifier.clickable(onClickLabel = label, role = Role.Button, onClick = onClick).tagged(tag) else Modifier)
            .padding(horizontal = 8.dp, vertical = 4.dp),
    )
}

@Composable
private fun RowIcon(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    Box(
        Modifier.size(28.dp).clip(Rounded4).clickable(onClickLabel = label, role = Role.Button, onClick = onClick).semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, Modifier.size(12.dp), tint = ToolDetail)
    }
}

@Composable
private fun PreviewChip(label: String, tag: String, onClick: () -> Unit) {
    Row(
        Modifier.clip(Rounded4).clickable(onClickLabel = label, role = Role.Button, onClick = onClick).tagged(tag).heightIn(min = 28.dp).padding(horizontal = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text("Preview", style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp, color = ToolDetail))
        Icon(ToolIcons.Maximize, null, Modifier.size(10.dp), tint = ToolDetail)
    }
}

@Composable
private fun DiffCounts(additions: Int, deletions: Int, divided: Boolean = false) {
    val style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 16.sp, fontFeatureSettings = "tnum")
    Row(
        (if (divided) Modifier.drawBehind { drawLine(ToolBorder, Offset(0f, 0f), Offset(0f, size.height), 1.dp.toPx()) }.padding(start = 8.dp) else Modifier),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (additions > 0 || !divided) Text("+$additions", style = style.copy(color = ThreadPalette.Add))
        if (deletions > 0 || !divided) Text("-$deletions", style = style.copy(color = ThreadPalette.Del))
    }
}

/**
 * A change's lines with one line of context around each edit and the rest folded into
 * "N hidden lines" rows: those that came with the diff open in place, the rest open the file there.
 */
@Composable
private fun DiffBody(change: ThreadFileChange, changeKey: String, c: Cards, openAt: ((Int?) -> Unit)?) {
    val rows = remember(change.lines) { ToolCards.diffRows(change.lines) }
    val lang = remember(change.path) { change.path.substringAfterLast('/').substringAfterLast('.', "").lowercase().ifEmpty { null } }
    val digits = remember(change.lines) { (change.lines.maxOfOrNull { maxOf(it.oldLine ?: 0, it.newLine ?: 0) } ?: 0).toString().length.coerceAtLeast(2) }
    val numbered = remember(change.lines) { ThreadView.numbered(change) }
    val runs = remember(rows, c.open.toMap()) { diffRuns(rows, changeKey, c.open) }
    Box(Modifier.fillMaxWidth().heightIn(max = OUTPUT_MAX).verticalScroll(rememberScrollState())) {
        Column(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).width(IntrinsicSize.Max).padding(vertical = 3.dp)) {
            var lastNew: Int? = null
            for (run in runs) {
                when (run) {
                    is DiffRun.Lines -> {
                        DiffLines(run.lines, lang, digits, numbered)
                        run.lines.lastOrNull { it.newLine != null }?.newLine?.let { lastNew = it }
                    }
                    is DiffRun.Hidden -> {
                        val h = run.row
                        val start = h.startLine ?: lastNew?.plus(1)
                        val onTap: (() -> Unit)? = when {
                            h.lines.isNotEmpty() -> ({ c.onFlip("$changeKey:${h.key}", false) })
                            openAt != null && start != null -> ({ openAt(start) })
                            else -> null
                        }
                        HiddenLines(h.count, onTap, Tags.Worker.threadMore("$changeKey:${h.key}"))
                    }
                }
            }
        }
    }
    if (change.truncated) {
        Text(
            "Showing the first ${change.lines.size} diff lines.",
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp, color = ToolDetail),
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
        )
    }
}

private sealed interface DiffRun {
    data class Lines(val lines: List<ThreadDiffLine>) : DiffRun
    data class Hidden(val row: ToolCards.DiffRow.Hidden) : DiffRun
}

/** Consecutive lines in one run, with the hidden rows the owner opened merged into their neighbours. */
private fun diffRuns(rows: List<ToolCards.DiffRow>, changeKey: String, open: Map<String, Boolean>): List<DiffRun> {
    val out = ArrayList<DiffRun>()
    val pending = ArrayList<ThreadDiffLine>()
    fun flush() {
        if (pending.isNotEmpty()) out += DiffRun.Lines(pending.toList())
        pending.clear()
    }
    for (r in rows) {
        when (r) {
            is ToolCards.DiffRow.Line -> pending += r.line
            is ToolCards.DiffRow.Hidden -> if (r.lines.isNotEmpty() && open["$changeKey:${r.key}"] == true) {
                pending += r.lines
            } else {
                flush()
                out += DiffRun.Hidden(r)
            }
        }
    }
    flush()
    return out
}

@Composable
private fun DiffLines(lines: List<ThreadDiffLine>, lang: String?, digits: Int, numbered: Boolean) {
    val text = remember(lines, lang, digits, numbered) { formatDiffLines(lines, lang, digits, numbered) }
    var layout by remember(lines) { mutableStateOf<TextLayoutResult?>(null) }
    Text(
        text,
        style = LocalOfficeType.current.monoBody.copy(fontSize = 11.sp, lineHeight = 17.sp),
        softWrap = false,
        onTextLayout = { layout = it },
        modifier = Modifier.fillMaxWidth().drawBehind {
            val l = layout ?: return@drawBehind
            for (idx in 0 until minOf(lines.size, l.lineCount)) {
                val bg = when (lines[idx].kind) {
                    DiffLineKind.Add -> ThreadPalette.AddRow
                    DiffLineKind.Del -> ThreadPalette.DelRow
                    else -> continue
                }
                val top = l.getLineTop(idx)
                drawRect(bg, topLeft = Offset(0f, top), size = Size(size.width, l.getLineBottom(idx) - top))
            }
        }.padding(end = 12.dp),
    )
}

/** Gutter number, sign and the line highlighted for its file; an Edit the office couldn't place has no gutter. */
private fun formatDiffLines(lines: List<ThreadDiffLine>, lang: String?, digits: Int, numbered: Boolean): AnnotatedString = buildAnnotatedString {
    lines.forEachIndexed { idx, line ->
        if (idx > 0) append('\n')
        val clean = line.text.replace('\n', ' ').replace('\r', ' ')
        val num = when (line.kind) {
            DiffLineKind.Del -> line.oldLine
            DiffLineKind.Add, DiffLineKind.Ctx -> line.newLine
            else -> null
        }
        val (sign, signColor) = when (line.kind) {
            DiffLineKind.Add -> "+" to ThreadPalette.Add
            DiffLineKind.Del -> "-" to ThreadPalette.Del
            else -> " " to ToolDetail
        }
        append("  ")
        if (numbered) withStyle(SpanStyle(color = ToolDetail)) { append((num?.toString() ?: "").padStart(digits)) }
        withStyle(SpanStyle(color = signColor)) { append(" $sign ") }
        if (line.kind == DiffLineKind.Note || line.kind == DiffLineKind.Hunk) {
            withStyle(SpanStyle(color = ToolDetail)) { append(clean) }
            return@forEachIndexed
        }
        for (tok in Markdown.tokenizeCode(clean, lang)) {
            withStyle(SpanStyle(color = tokenColor(tok.kind, ThreadPalette.Text))) { append(tok.text) }
        }
    }
}

@Composable
private fun HiddenLines(count: Int, onTap: (() -> Unit)?, tag: String) {
    val label = if (count == 1) "1 hidden line" else "$count hidden lines"
    Row(
        Modifier.fillMaxWidth().background(ThreadPalette.SurfaceRaised)
            .then(if (onTap != null) Modifier.clickable(onClickLabel = "Show $label", role = Role.Button, onClick = onTap) else Modifier)
            .tagged(tag).heightIn(min = 24.dp).padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(ToolIcons.ChevronsUpDown, null, Modifier.size(12.dp), tint = ToolDetail)
        Text(label, style = LocalOfficeType.current.monoBody.copy(fontSize = 11.sp, lineHeight = 14.sp, color = ToolDetail), maxLines = 1)
    }
}

@Composable
private fun DelegationRow(a: ThreadModelAction, c: Cards, nested: Boolean) {
    val del = a.delegation
    val matchedWorker = remember(del, c.allWorkers) {
        if (del == null) null
        else del.workerId?.let(c.deskWorker)
            ?: del.workerName?.let { name -> c.allWorkers.firstOrNull { it.name.equals(name, ignoreCase = true) } }
    }
    val (verb, subject) = if (a.verb != null) ToolCards.words(a) else {
        val agent = del?.agent?.ifBlank { null } ?: "Subagent"
        agent to (del?.summary?.ifBlank { null } ?: a.title)
    }
    val isOpen = ThreadView.Open.action(a, c.open)
    ToolRow(
        glyph = ToolCards.Glyph.Bot,
        line = remember(verb, subject) { toolLine(verb, subject) },
        working = a.state == ActivityState.Working,
        isOpen = isOpen,
        onToggle = { c.onFlip(a.id, isOpen) },
        modifier = Modifier.tagged(Tags.Worker.threadEntry(a.id)),
        toggleTag = Tags.Worker.threadToggle(a.id),
        dense = nested,
        endLabel = ToolCards.endLabel(a),
        end = if (c.onOpenWorker != null && matchedWorker != null) {
            {
                Row(
                    Modifier.clip(Rounded4).clickable(onClickLabel = "Open ${matchedWorker.name}", role = Role.Button) { c.onOpenWorker(matchedWorker.id) }
                        .tagged(Tags.Worker.threadDelegateOpen(a.id)).heightIn(min = 28.dp).padding(horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text("Open", style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp, color = ToolDetail))
                    Icon(ToolIcons.Maximize, null, Modifier.size(10.dp), tint = ToolDetail)
                }
            }
        } else null,
    ) {
        ToolBox { ActionDetailsBody(a, c.loaded[a.id], Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) }
    }
}

@Composable
private fun ActionDetailsBody(a: ThreadModelAction, entry: ThreadEntry?, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        val canShow = LocalPictureSource.current != null
        when (val d = remember(a, entry?.input, entry?.output, entry?.images, canShow) { ThreadView.detail(a, entry, canShow) }) {
            ThreadView.Detail.NotLoaded -> Text(
                ThreadView.NOT_LOADED, style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, color = ToolDetail),
                modifier = Modifier.tagged(Tags.Worker.threadNotLoaded(a.id)),
            )
            is ThreadView.Detail.Shown -> {
                d.arguments?.let { (label, body) -> Mono(label, body, ThreadPalette.TextSecondary) }
                val pictures = d.images.isNotEmpty()
                if (d.recorded) {
                    if (d.output.isNotEmpty() || !pictures) {
                        Mono(d.result, d.output.ifEmpty { "(empty)" }, if (a.state == ActivityState.Failed) ThreadPalette.Danger else ThreadPalette.TextSecondary)
                    }
                    if (pictures) ThreadPictures(d.images, a.title, a.detail, end = false)
                } else {
                    Text(d.result, style = endStyle())
                    Text(d.output, style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, color = ToolDetail))
                }
            }
        }
    }
}

@Composable
private fun Mono(label: String, body: String, color: Color) {
    Text(label, style = endStyle())
    val shown = if (body.length > SHOWN_CHARS) body.take(SHOWN_CHARS) else body
    ThreadSelection {
        Text(shown, style = LocalOfficeType.current.monoBody.copy(fontSize = 11.sp, lineHeight = 17.sp, color = color))
    }
    if (shown.length < body.length) {
        Text("Showing the first $SHOWN_CHARS of ${body.length} characters. Raw TTY has the rest.", style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp, color = ToolDetail))
    }
}

// --- Plan (todoPlanVisualizer) -----------------------------------------------------------------

/** A step's mark: a spinner while it's in progress and the worker works, else a dot, accent once done. */
@Composable
private fun StepMark(step: PlanStep, working: Boolean) {
    Box(Modifier.size(16.dp).clearAndSetSemantics { contentDescription = ToolCards.stepState(step) }, contentAlignment = Alignment.Center) {
        if (step.active && working) Spinner(Modifier.size(12.dp), ThreadPalette.TextSecondary)
        else Box(Modifier.size(6.dp).clip(CircleShape).background(if (step.done) ThreadPalette.Accent else ThreadPalette.TextSecondary))
    }
}

@Composable
private fun PlanList(steps: List<PlanStep>, working: Boolean, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (s in steps) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StepMark(s, working)
                Text(
                    s.text,
                    style = MaterialTheme.typography.bodySmall.copy(
                        fontSize = 12.sp, lineHeight = 16.sp,
                        color = if (s.done) ThreadPalette.TextSecondary else ThreadPalette.Text,
                    ),
                    maxLines = 2, overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/**
 * The plan above the composer: every step while open, only what is in progress (else the next step)
 * while closed, scrolling past 240 dp. Gone once every step is done.
 */
@Composable
internal fun StickyPlanBar(plan: ActivePlan, isOpen: Boolean, onToggle: () -> Unit, modifier: Modifier = Modifier, working: Boolean = true) {
    if (plan.allDone || plan.steps.isEmpty()) return
    val shown = remember(plan.steps, isOpen) { ToolCards.planShown(plan.steps, isOpen) }
    Row(
        modifier.panel(Rounded4, ThreadPalette.Surface, ToolBorder).tagged(Tags.Worker.THREAD_PLAN),
        verticalAlignment = Alignment.Top,
    ) {
        Box(Modifier.weight(1f).heightIn(max = 240.dp).verticalScroll(rememberScrollState())) {
            PlanList(shown, working, Modifier.padding(start = 12.dp, top = 10.dp, bottom = 10.dp))
        }
        Box(
            Modifier.padding(start = 8.dp, end = 4.dp, top = 2.dp).size(32.dp).clip(Rounded4)
                .disclosure(isOpen, onToggle)
                .semantics { contentDescription = if (isOpen) "Collapse plan progress" else "Expand plan progress" }
                .tagged(Tags.Worker.THREAD_PLAN_TOGGLE),
            contentAlignment = Alignment.Center,
        ) {
            Icon(if (isOpen) ToolIcons.ChevronsDownUp else ToolIcons.ChevronsUpDown, null, Modifier.size(14.dp), tint = ThreadPalette.TextSecondary)
        }
    }
}

// --- Turn changes ------------------------------------------------------------------------------

private fun filesWord(count: Int) = if (count == 1) "1 file" else "$count files"

/** What a finished turn changed, under its last message or Activity: each file opens in the file preview where there is one. */
@Composable
internal fun TurnChanges(rowId: String, changes: ThreadTurnChanges, floorDir: String?, modifier: Modifier = Modifier) {
    val preview = LocalFilePreview.current
    Column(modifier.fillMaxWidth().panel(Rounded4, ThreadPalette.Surface, ToolBorder).tagged(Tags.Worker.threadTurnChanges(rowId))) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = ROW_MIN).padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(ToolIcons.FileDiff, null, Modifier.size(14.dp), tint = ToolLabel)
            Text(toolLine("Changed", filesWord(changes.count)), style = toolStyle(), modifier = Modifier.weight(1f))
            DiffCounts(changes.additions, changes.deletions)
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(ToolBorder))
        Column(Modifier.padding(vertical = 4.dp)) {
            changes.files.forEachIndexed { i, file ->
                val rel = remember(file.path, floorDir) { ThreadView.workspacePath(file.path, floorDir) }
                val openFile: (() -> Unit)? = if (preview != null && rel != null) {
                    { preview.openFilePreview(rel) }
                } else null
                Row(
                    Modifier.fillMaxWidth()
                        .then(if (openFile != null) Modifier.clickable(onClickLabel = "Open file", role = Role.Button, onClick = openFile) else Modifier)
                        .tagged(Tags.Worker.threadTurnFile(rowId, i))
                        .heightIn(min = 32.dp)
                        .padding(horizontal = 10.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        file.shortPath,
                        style = LocalOfficeType.current.monoBody.copy(
                            fontSize = 12.sp, lineHeight = 16.sp, color = ThreadPalette.TextSecondary,
                            textDecoration = if (openFile != null) TextDecoration.Underline else null,
                        ),
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                    )
                    DiffCounts(file.additions, file.deletions)
                }
            }
            val more = changes.count - changes.files.size
            if (more > 0) {
                Text("and $more more", style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, color = ToolDetail), modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp))
            }
        }
    }
}
