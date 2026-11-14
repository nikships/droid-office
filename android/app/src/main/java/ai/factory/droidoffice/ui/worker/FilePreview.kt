package ai.factory.droidoffice.ui.worker

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.OfficeJson
import ai.factory.droidoffice.core.ORCHESTRATOR_ID
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.core.WorkspacePaths
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette

/**
 * Opens a file of the worker's workspace in a read-only sheet, as the web Thread's file preview
 * does: from a `path:line` link in a message, a File Change card or anything else in the Thread.
 * Read it from [LocalFilePreview]; it is null when the worker's files can't be read (a cloud or
 * shell worker).
 */
@Stable
class FilePreview internal constructor(private val show: (WorkspacePaths.Ref) -> Unit) {
    /** [path] is relative to the worker's workspace; [line] (from 1) is scrolled to and marked, through [endLine] when given. */
    fun openFilePreview(path: String, line: Int? = null, endLine: Int? = null) {
        val clean = path.trim().replace('\\', '/').removePrefix("./")
        if (clean.isEmpty()) return
        val start = line?.takeIf { it >= 1 }
        show(WorkspacePaths.Ref(clean, start, endLine?.takeIf { start != null && it > start }))
    }

    internal fun open(ref: WorkspacePaths.Ref) = openFilePreview(ref.path, ref.line, ref.endLine)
}

val LocalFilePreview = staticCompositionLocalOf<FilePreview?> { null }

/** Gives [content] the worker's [FilePreview] and shows the file it opens. */
@Composable
internal fun ProvideFilePreview(w: WorkerInfo, content: @Composable () -> Unit) {
    val data by LocalGraph.current.connection.data.collectAsStateWithLifecycle()
    val floor = if (w.id == ORCHESTRATOR_ID) null else data.workerFloorId(w.id) ?: data.floorId
    // The office reads files only from the folder a local Droid works in (`resolveThreadCwd`).
    val readable = !w.isCloud && !w.isShell && (floor != null || w.id == ORCHESTRATOR_ID)
    var showing by remember(w.id) { mutableStateOf<WorkspacePaths.Ref?>(null) }
    val preview = remember(w.id, readable) { if (readable) FilePreview { showing = it } else null }
    CompositionLocalProvider(LocalFilePreview provides preview, content = content)
    showing?.let { ref -> FilePreviewSheet(w, floor, ref) { showing = null } }
}

private sealed interface FileState {
    data object Loading : FileState
    data class Failed(val message: String) : FileState
    data class Loaded(val preview: WorkspacePaths.Preview) : FileState
}

private fun languageOf(path: String): String {
    val base = path.substringAfterLast('/')
    val dot = base.lastIndexOf('.')
    return if (dot > 0 && dot < base.length - 1) base.substring(dot + 1).lowercase() else base.lowercase()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FilePreviewSheet(w: WorkerInfo, floor: String?, ref: WorkspacePaths.Ref, onDismiss: () -> Unit) {
    val connection = LocalGraph.current.connection
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var state by remember(ref) { mutableStateOf<FileState>(FileState.Loading) }
    LaunchedEffect(ref) {
        state = FileState.Loading
        state = connection.threadFile(floor, w.id, ref.path).fold(
            onSuccess = { (code, body) ->
                val json = runCatching { OfficeJson.parseToJsonElement(body) }.getOrNull()
                val parsed = WorkspacePaths.preview(json, ref.path)
                when {
                    // An office from before Thread file previews answers with its plain "Not found".
                    code == 404 && json == null -> FileState.Failed("Update Droid Office on your computer to preview files here.")
                    code !in 200..299 || parsed.error != null -> FileState.Failed(parsed.error ?: "Couldn’t load ${ref.path} (HTTP $code).")
                    else -> FileState.Loaded(parsed)
                }
            },
            onFailure = { FileState.Failed(it.message ?: "Network error while reading file.") },
        )
    }
    val mono = LocalOfficeType.current
    val language = remember(ref.path) { languageOf(ref.path) }
    val subtitle = listOf(WorkspacePaths.lineLabel(ref.line, ref.endLine), "${w.name.ifBlank { "Droid" }} workspace").filter { it.isNotEmpty() }.joinToString(" · ")
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, containerColor = Palette.Surface, shape = RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp)) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.92f).tagged(Tags.Worker.THREAD_FILE).navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(OfficeIcons.File, null, tint = Palette.TextSecondary, modifier = Modifier.size(16.dp))
                Column(Modifier.weight(1f).padding(start = 10.dp)) {
                    Text(
                        ref.path, style = mono.monoBody.copy(fontSize = 13.sp, color = Palette.Text),
                        maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.tagged(Tags.Worker.THREAD_FILE_PATH),
                    )
                    Text(subtitle, style = MaterialTheme.typography.bodySmall.copy(color = Palette.TextSecondary), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                CopyActionChip("COPY PATH", ref.path, "Path", Tags.Worker.THREAD_FILE_COPY_PATH)
                val loaded = state as? FileState.Loaded
                if (loaded != null && !loaded.preview.binary) CopyActionChip("COPY FILE", loaded.preview.content, "File", Tags.Worker.THREAD_FILE_COPY)
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Border))
            when (val s = state) {
                FileState.Loading -> Row(
                    Modifier.fillMaxWidth().padding(20.dp).tagged(Tags.Worker.THREAD_FILE_STATUS),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Spinner(Modifier.size(14.dp), Palette.TextSecondary)
                    Text("Loading file…", style = MaterialTheme.typography.bodyMedium.copy(color = Palette.TextSecondary))
                }
                is FileState.Failed -> FileNote("Couldn’t open file", s.message)
                is FileState.Loaded -> {
                    val p = s.preview
                    val size = WorkspacePaths.formatBytes(p.size)
                    when {
                        p.binary -> FileNote("Binary file", "${p.path} is a binary file${if (size.isNotEmpty()) " ($size)" else ""} and cannot be previewed as text.")
                        p.lines.isEmpty() -> FileNote("Empty file", "${p.path} is empty.")
                        else -> FileLines(p, ref, language, size, Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

@Composable
private fun FileNote(title: String, message: String) {
    Column(Modifier.fillMaxWidth().padding(20.dp).tagged(Tags.Worker.THREAD_FILE_STATUS), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall)
        Text(message, style = MaterialTheme.typography.bodyMedium.copy(color = Palette.TextSecondary))
    }
}

@Composable
private fun FileLines(p: WorkspacePaths.Preview, ref: WorkspacePaths.Ref, language: String, size: String, modifier: Modifier) {
    val type = LocalOfficeType.current
    val start = ref.line
    val stop = start?.let { maxOf(it, ref.endLine ?: it) }
    // A line past the end (a stale reference, or a cut-off preview) lands on the last line shown.
    val target = start?.let { minOf(it, p.lines.size) }
    val list = rememberLazyListState()
    LaunchedEffect(p, target) {
        val line = target ?: return@LaunchedEffect
        list.scrollToItem(line - 1)
        val info = list.layoutInfo
        val row = info.visibleItemsInfo.firstOrNull { it.index == line - 1 } ?: return@LaunchedEffect
        val viewport = info.viewportEndOffset - info.viewportStartOffset
        list.scrollBy(-((viewport - row.size) / 2f))
    }
    val digits = p.lines.size.toString().length
    val numberWidth = (digits * 8 + 14).dp
    Column(modifier.fillMaxWidth()) {
        if (p.truncated) Text(
            "Showing the first ${p.lines.size} lines of ${p.path} (${if (size.isNotEmpty()) "$size total, " else ""}truncated for preview).",
            style = MaterialTheme.typography.bodySmall.copy(color = Palette.Info),
            modifier = Modifier.fillMaxWidth().background(Palette.Info.copy(alpha = 0.08f)).padding(horizontal = 16.dp, vertical = 8.dp).tagged(Tags.Worker.THREAD_FILE_STATUS),
        )
        LazyColumn(Modifier.weight(1f).fillMaxWidth().tagged(Tags.Worker.THREAD_FILE_LINES), state = list) {
            itemsIndexed(p.lines, key = { i, _ -> i }) { i, line ->
                val n = i + 1
                val marked = when {
                    start == null -> false
                    start > p.lines.size -> n == p.lines.size
                    else -> n in start..(stop ?: start)
                }
                val code = remember(line, language) { highlightedCode(line, language) }
                Row(
                    Modifier.fillMaxWidth().background(if (marked) Palette.Accent.copy(alpha = 0.14f) else Palette.Surface)
                        .semantics { selected = marked }.tagged(Tags.Worker.threadFileLine(n)),
                ) {
                    Box(Modifier.width(3.dp).heightIn(min = 18.dp).background(if (marked) Palette.Accent else Palette.Surface))
                    Text(
                        "$n", style = type.monoBody.copy(fontSize = 11.5.sp, lineHeight = 18.sp, color = if (marked) Palette.Text else Palette.TextTertiary),
                        modifier = Modifier.width(numberWidth).padding(end = 8.dp),
                        textAlign = TextAlign.End,
                    )
                    Text(
                        if (line.isEmpty()) AnnotatedString(" ") else code,
                        style = type.monoBody.copy(fontSize = 12.sp, lineHeight = 18.sp),
                        modifier = Modifier.weight(1f).padding(end = 12.dp),
                    )
                }
            }
        }
        val shown = p.totalLines ?: p.lines.size
        Text(
            listOf("$shown line${if (shown == 1) "" else "s"}", size, if (p.truncated) "truncated" else "").filter { it.isNotEmpty() }.joinToString(" · "),
            style = type.eyebrow.copy(color = Palette.TextSecondary),
            modifier = Modifier.fillMaxWidth().background(Palette.SurfaceRaised).padding(horizontal = 16.dp, vertical = 8.dp).tagged(Tags.Worker.THREAD_FILE_META),
        )
    }
}
