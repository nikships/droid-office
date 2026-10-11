package ai.factory.droidoffice.core

/** A worker waiting on a question, with the menu its terminal shows when one can be read. */
data class PendingAsk(val worker: WorkerInfo, val menu: Menu?)

/** The Asks tab: who is waiting on an answer, oldest first, and what to show for each. */
object Asks {
    /** Desk and kiosk workers waiting on the owner, whoever has waited longest first. */
    fun queue(workers: Collection<WorkerInfo>, screens: Map<String, ScreenState>): List<PendingAsk> =
        workers.filter { it.state == WorkerStatus.NeedsInput }
            .sortedWith(compareBy<WorkerInfo> { it.waitingSince ?: Long.MAX_VALUE }.thenBy { it.createdAt }.thenBy { it.id })
            .map { w -> PendingAsk(w, menu(w, screens[w.id])) }

    /** The numbered menu on its screen: a shell's numbered output is never an ask. */
    fun menu(w: WorkerInfo, screen: ScreenState?): Menu? = if (w.isShell || screen == null) null else Choices.read(screen)

    /** One line of what it's on, above the question: its task or title, else the start of its prompt. */
    fun context(w: WorkerInfo): String? =
        (Workers.title(w) ?: w.prompt?.lineSequence()?.firstOrNull { it.isNotBlank() })?.trim()?.take(140)?.takeIf { it.isNotBlank() }

    /** The question to show: the one on the screen, else what the office says it's waiting on. */
    fun question(ask: PendingAsk): String =
        ask.menu?.question ?: Workers.detail(ask.worker) ?: "${ask.worker.name.ifBlank { "It" }} is waiting on an answer"

    /** The bottom line of its terminal with the box drawing taken off: the live line under a thread. */
    fun liveLine(screen: ScreenState?): String? = screen?.lines
        ?.map { row -> row.joinToString("") { it.text }.trim('│', '┃', '║', '|', '╭', '╮', '╰', '╯', '─', ' ', '\u00A0') }
        ?.lastOrNull { it.isNotBlank() && it.any(Char::isLetterOrDigit) }

    /** A choice's label short enough for a notification button: "1 · Wait for drawer". */
    fun buttonLabel(choice: Choice, max: Int = 22): String {
        val label = if (choice.label.length <= max) choice.label else choice.label.take(max - 1).trimEnd() + "…"
        return "${choice.number} · $label"
    }

    /** A reply typed into a notification: a bare digit picks that choice, anything else is the owner's own answer. */
    fun replyKeys(menu: Menu?, text: String): String? {
        val t = text.trim()
        if (menu == null || t.isEmpty()) return null
        t.toIntOrNull()?.let { n -> menu.choices.firstOrNull { it.number == n }?.let { return Choices.keys(menu, it) } }
        return Choices.textKeys(menu, t)
    }
}
