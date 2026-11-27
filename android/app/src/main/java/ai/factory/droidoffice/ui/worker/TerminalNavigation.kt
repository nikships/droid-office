package ai.factory.droidoffice.ui.worker

import ai.factory.droidoffice.core.PageMsg
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.TermPage
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** Navigation reads the local terminal even when input to its PTY is disabled. */
internal class TerminalNavigation {
    var finding by mutableStateOf(false)
    var query by mutableStateOf("")
    var prompts by mutableStateOf(false)
    var matches by mutableStateOf(PageMsg.Matches(-1, 0, false, false, 0))
        private set
    var page by mutableStateOf<TerminalPage?>(null)
        private set

    fun open() {
        finding = true
        find("")
    }

    fun find(text: String) {
        query = text.take(1024)
        invalidateMatches()
        page?.send(TermPage.search(query, matches.request))
    }

    fun invalidateMatches() {
        matches = PageMsg.Matches(-1, 0, finding && query.isNotEmpty(), false, matches.request + 1)
    }

    fun accept(result: PageMsg.Matches) {
        if (finding && query.isNotEmpty() && result.request == matches.request) matches = result
    }

    fun setRenderer(next: TerminalPage?) {
        if (page === next) return
        page = next
        prompts = false
        invalidateMatches()
    }

    fun detach(current: TerminalPage) {
        if (page === current) setRenderer(null)
    }

    fun close() {
        page?.send(TermPage.closeSearch())
        closed()
    }

    fun onDrawn() {
        if (finding && query.isNotEmpty()) find(query)
    }

    fun closed(request: Int = matches.request) {
        if (request != matches.request) return
        finding = false
        query = ""
        invalidateMatches()
    }
}

@Composable
internal fun TerminalNavActions(nav: TerminalNavigation) {
    Row {
        IconButton(onClick = { if (nav.finding) nav.close() else nav.open() }, enabled = nav.page != null, modifier = Modifier.tagged(Tags.Worker.TERM_FIND)) {
            Icon(OfficeIcons.Search, "Find in terminal", Modifier.size(18.dp), tint = if (nav.finding) Palette.Accent else Palette.TextSecondary)
        }
        if (nav.prompts) {
            IconButton(onClick = { nav.page?.send(TermPage.navigate(true, false)) }, modifier = Modifier.tagged(Tags.Worker.TERM_PROMPT_PREV)) {
                Icon(OfficeIcons.ArrowUp, "Previous prompt", Modifier.size(18.dp))
            }
            IconButton(onClick = { nav.page?.send(TermPage.navigate(true, true)) }, modifier = Modifier.tagged(Tags.Worker.TERM_PROMPT_NEXT)) {
                Icon(OfficeIcons.ArrowDown, "Next prompt", Modifier.size(18.dp))
            }
        }
    }
}

@Composable
internal fun TerminalFindBar(nav: TerminalNavigation) {
    BackHandler(onBack = nav::close)
    val matches = nav.matches
    ThreadSearchBar(
        query = nav.query, active = matches.active, count = matches.count, onQuery = nav::find,
        onStep = { nav.page?.send(TermPage.navigate(false, it > 0)) }, onClose = nav::close, terminal = true,
        status = when {
            nav.query.isEmpty() -> ""
            matches.searching -> "Searching…"
            matches.limited -> "${matches.active + 1} of ${matches.count}+"
            else -> null
        },
    )
}
