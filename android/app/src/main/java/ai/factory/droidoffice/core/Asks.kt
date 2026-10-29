package ai.factory.droidoffice.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

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

    /** The thread can answer only a live local worker's waiting question with a readable menu. */
    fun canAnswer(w: WorkerInfo, screen: ScreenState?): Boolean =
        w.state == WorkerStatus.NeedsInput && !w.isShell && !w.isCloud && !w.isGuest && menu(w, screen) != null

    /** One line of what it's on, above the question: its task or title, else the start of its prompt. */
    fun context(w: WorkerInfo): String? =
        (Workers.title(w) ?: w.prompt?.lineSequence()?.firstOrNull { it.isNotBlank() })?.trim()?.take(140)?.takeIf { it.isNotBlank() }

    /**
     * The question to show: the one on the screen, else the one its open ask call in the thread
     * carries, else what the office says it's waiting on. The CLI's own notice ("Factory CLI is
     * asking the user 1 question(s)") says nothing a reader can answer, so it never stands in.
     */
    fun question(ask: PendingAsk, entries: List<ThreadEntry> = emptyList()): String =
        asked(entries, ask.menu)
            ?: ask.menu?.question
            ?: Workers.detail(ask.worker)?.takeUnless(::generic)
            ?: "${ask.worker.name.ifBlank { "It" }} is waiting on an answer"

    private val GENERIC = Regex("""\bis asking the user\b|\basking (you|the user) \d+ question""", RegexOption.IGNORE_CASE)

    /** A notification line that only says a question was asked, not which. */
    fun generic(text: String): Boolean = GENERIC.containsMatchIn(text)

    private val ASK_TOOLS = setOf("AskUser", "AskUserQuestion", "request_user_input")
    private val QUESTION_LINE = Regex("""^\s*(?:\d+[.)]\s*)?\[question]\s*(.+)$""")
    private val OPTION_LINE = Regex("""^\s*\[option]\s*(.+)$""")
    private val MULTI = Regex("""\s*\(multi\)\s*$""", RegexOption.IGNORE_CASE)

    /** A question as its ask call wrote it, with the options it offered. */
    data class Asked(val question: String, val options: List<String>, val multiSelect: Boolean = false)

    /**
     * The questions of the newest ask call still waiting on a result: Droid's `questionnaire`
     * ("1. [question] …" then "[option] …" lines) or a `questions` array of `{question, options}`.
     */
    fun questions(entries: List<ThreadEntry>): List<Asked> {
        val call = entries.lastOrNull { it.kind == ThreadKind.Tool && it.name in ASK_TOOLS } ?: return emptyList()
        if (call.output != null) return emptyList()
        val o = call.input?.trim()?.takeIf { it.startsWith("{") }
            ?.let { runCatching { OfficeJson.parseToJsonElement(it) as? JsonObject }.getOrNull() } ?: return emptyList()
        (o["questionnaire"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { text ->
            val out = ArrayList<Asked>()
            var question: String? = null
            val options = ArrayList<String>()
            var lastOption = false
            var continuingQuestion = false
            var multiSelect = false
            fun flush() {
                question?.let { out += Asked(it.trim(), options.map(String::trim), multiSelect) }
                question = null
                options.clear()
                multiSelect = false
            }
            for (line in text.lines()) {
                QUESTION_LINE.matchEntire(line)?.let {
                    flush()
                    multiSelect = MULTI.containsMatchIn(it.groupValues[1])
                    question = it.groupValues[1].replace(MULTI, "").trim()
                    lastOption = false
                    continuingQuestion = true
                } ?: OPTION_LINE.matchEntire(line)?.let {
                    if (question != null) options += it.groupValues[1].trim()
                    lastOption = true
                } ?: run {
                    if (line.trimStart().startsWith("[topic]")) {
                        lastOption = false
                        continuingQuestion = false
                    }
                    else if (question != null) {
                        if (lastOption && options.isNotEmpty()) options[options.lastIndex] += "\n$line"
                        else if (continuingQuestion) {
                            if (MULTI.containsMatchIn(line)) multiSelect = true
                            question += "\n${line.replace(MULTI, "")}"
                        }
                    }
                }
            }
            flush()
            return out.filter { it.question.isNotEmpty() }
        }
        return (o["questions"] as? JsonArray).orEmpty().mapNotNull { q ->
            val qo = q as? JsonObject ?: return@mapNotNull null
            val text = (qo["question"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()?.ifEmpty { null } ?: return@mapNotNull null
            val options = (qo["options"] as? JsonArray).orEmpty().mapNotNull { opt ->
                when (opt) {
                    is JsonPrimitive -> opt.takeIf { it.isString }?.content
                    is JsonObject -> (opt["label"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                    else -> null
                }?.trim()
            }
            Asked(text, options, (qo["multiSelect"] as? JsonPrimitive)?.booleanOrNull == true || (qo["multi_select"] as? JsonPrimitive)?.booleanOrNull == true)
        }
    }

    /**
     * The open ask call's question whose ordered options and mode match [menu].
     * Ambiguous or mismatching questions never replace the screen's text.
     */
    fun asked(entries: List<ThreadEntry>, menu: Menu?): String? {
        val all = questions(entries)
        if (all.isEmpty()) return null
        return matching(all, menu)?.question
    }

    private fun norm(s: String) = s.lowercase().replace(Regex("""\s+"""), " ").trim().trimEnd('…', '.')

    /** Match by numbered prefixes, never by an option appearing at a different number. */
    private fun matching(all: List<Asked>, menu: Menu?): Asked? {
        if (menu == null) return all.singleOrNull()
        val candidates = all.filter { a ->
            a.multiSelect == menu.multiSelect && a.options.size == menu.choices.size && menu.choices.all { c ->
                val label = norm(c.label)
                val full = a.options.getOrNull(c.number - 1)?.let(::norm).orEmpty()
                label.isNotEmpty() && full.startsWith(label)
            }
        }
        if (candidates.size == 1) return candidates.single()
        // Several questions may use identical options. Only a unique matching question disambiguates.
        return candidates.filter { a ->
            val q = menu.question?.let(::norm) ?: return@filter false
            val full = norm(a.question)
            full == q || full.endsWith(q)
        }.singleOrNull()
    }

    /** Full pending-call metadata is for display only. Send the original screen menu, never this copy. */
    fun display(menu: Menu, entries: List<ThreadEntry>): Menu {
        val asked = matching(questions(entries), menu) ?: return menu
        return menu.copy(
            question = asked.question,
            choices = menu.choices.map { c -> c.copy(label = asked.options[c.number - 1].trim(), description = null) },
        )
    }
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
        if (menu == null || menu.multiSelect || t.isEmpty()) return null
        t.toIntOrNull()?.let { n -> menu.choices.firstOrNull { it.number == n }?.let { return Choices.keys(menu, it) } }
        return Choices.textKeys(menu, t)
    }
}
