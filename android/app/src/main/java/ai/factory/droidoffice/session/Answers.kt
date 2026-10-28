package ai.factory.droidoffice.session

import ai.factory.droidoffice.core.Asks
import ai.factory.droidoffice.core.Choices
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.Menu
import ai.factory.droidoffice.core.QuestionAnswers
import ai.factory.droidoffice.core.WorkerStatus
import java.util.UUID

/** Only [Sent] means the office confirmed the answer, not just a socket write. */
enum class Answered { Sent, Changed, Unreachable, NeedsThread, Unconfirmed, Refused }

class Answers(private val connection: OfficeConnection) {
    fun current(workerId: String): Menu? {
        val w = connection.data.value.workers[workerId]?.takeIf {
            it.state == WorkerStatus.NeedsInput && !it.isShell && !it.isCloud && !it.isGuest
        } ?: return null
        return Asks.menu(w, connection.screens.value[workerId])
    }

    suspend fun choose(workerId: String, shown: Menu, number: Int): Answered =
        if (shown.multiSelect) Answered.NeedsThread else submit(workerId, shown, choice = number)

    suspend fun type(workerId: String, shown: Menu, text: String): Answered = submit(workerId, shown, text = text)

    /** Screen menu is authoritative for send; selection is a complete desired set, not a toggle. */
    suspend fun submit(workerId: String, shown: Menu, choice: Int? = null, choices: List<Int>? = null, text: String? = null): Answered {
        if (!connection.connected) return Answered.Unreachable
        val now = current(workerId)
        if (!Choices.same(shown, now) || now == null) return Answered.Changed
        if (now.multiSelect && !connection.data.value.workerAnswerMultiSelect) return Answered.NeedsThread
        if (!QuestionAnswers.valid(now, choice, choices, text)) return Answered.NeedsThread
        val request = UUID.randomUUID().toString()
        val receipt = connection.answerConfirmed(request, ClientMsg.workerAnswer(workerId, shown, request, connection.data.value.floorId, choice, choices, text))
            ?: return Answered.Unconfirmed
        return if (receipt.ok) Answered.Sent else Answered.Refused
    }
}
