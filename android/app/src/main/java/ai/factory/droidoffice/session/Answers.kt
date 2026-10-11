package ai.factory.droidoffice.session

import ai.factory.droidoffice.core.Asks
import ai.factory.droidoffice.core.Choices
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.Keys
import ai.factory.droidoffice.core.Menu
import ai.factory.droidoffice.core.WorkerStatus
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull

/** How an answer went. */
enum class Answered {
    /** The keys went to the worker. */
    Sent,
    /** The question on its screen isn't the one that was answered any more: nothing was sent. */
    Changed,
    /** No connection to the office. */
    Unreachable,
    /** Its menu has no row to type into that the phone could reach: the thread should take over. */
    NeedsThread,
}

/**
 * Answers a worker's question from outside its terminal (the Asks tab, a notification). Before any
 * key goes out it reads the worker's screen again, and sends nothing when the question there is no
 * longer the one that was shown: keys typed into a TTY can't be taken back.
 */
class Answers(private val connection: OfficeConnection) {
    /** The menu on the worker's screen right now, while it's waiting on an answer. */
    fun current(workerId: String): Menu? {
        val w = connection.data.value.workers[workerId]?.takeIf { it.state == WorkerStatus.NeedsInput } ?: return null
        return Asks.menu(w, connection.screens.value[workerId])
    }

    /** Picks choice [number] of [shown], if the screen still asks it. */
    fun choose(workerId: String, shown: Menu, number: Int): Answered {
        val now = current(workerId)
        if (!Choices.same(shown, now) || now == null) return Answered.Changed
        val choice = now.choices.firstOrNull { it.number == number } ?: return Answered.Changed
        return if (connection.answer(workerId, Choices.keys(now, choice))) Answered.Sent else Answered.Unreachable
    }

    /**
     * Answers [shown] with the owner's own [text]. A numbered "Other" takes its digit and the text.
     * Droid's own-answer row is reached with the arrow keys, and the text goes in only once the
     * screen shows the row has the highlight (its hints turn to "Enter Submit answer"); otherwise
     * nothing more is typed and the thread takes over.
     */
    suspend fun type(workerId: String, shown: Menu, text: String): Answered {
        val now = current(workerId)
        if (!Choices.same(shown, now) || now == null) return Answered.Changed
        val line = text.replace(Regex("""[\r\n]+"""), " ").trim()
        if (line.isEmpty()) return Answered.NeedsThread
        if (!now.freeText) {
            val keys = Choices.textKeys(now, line) ?: return Answered.NeedsThread
            return if (connection.answer(workerId, keys)) Answered.Sent else Answered.Unreachable
        }
        val arrows = Choices.toTextRow(now) ?: return Answered.NeedsThread
        connection.attach(workerId)
        try {
            if (!connection.send(ClientMsg.termInput(workerId, arrows))) return Answered.Unreachable
            val there = withTimeoutOrNull(ROW_WAIT_MS) {
                connection.screens.first { s -> s[workerId]?.let(Choices::onTextRow) == true }
            } != null
            if (!there) return Answered.NeedsThread
            return if (connection.send(ClientMsg.termInput(workerId, line + Keys.ENTER))) Answered.Sent else Answered.Unreachable
        } finally {
            connection.detach(workerId)
        }
    }

    private companion object {
        const val ROW_WAIT_MS = 2_500L
    }
}
