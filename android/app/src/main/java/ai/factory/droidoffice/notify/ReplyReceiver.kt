package ai.factory.droidoffice.notify

import ai.factory.droidoffice.core.Choice
import ai.factory.droidoffice.core.Menu
import ai.factory.droidoffice.session.Answered
import ai.factory.droidoffice.session.OfficeConnection
import ai.factory.droidoffice.session.Phase
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.graph
import kotlinx.coroutines.launch

/** A direct reply typed into a worker's notification: sent to it as a prompt, like the composer does. */
class ReplyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY_TEXT)?.toString()?.trim().orEmpty()
        val workerId = intent.getStringExtra(EXTRA_WORKER)?.takeIf { ID.matches(it) } ?: return
        val officeId = intent.getStringExtra(EXTRA_OFFICE).orEmpty()
        val name = intent.getStringExtra(EXTRA_NAME)?.take(40) ?: "the worker"
        val choice = intent.getIntExtra(EXTRA_CHOICE, 0)
        // The question the notification showed, to check against the screen before anything is typed.
        val shown = intent.getStringArrayListExtra(EXTRA_LABELS)?.takeIf { it.size >= 2 }?.let { labels ->
            Menu(intent.getStringExtra(EXTRA_QUESTION), labels.mapIndexed { i, l -> Choice(i + 1, l) }, null, intent.getBooleanExtra(EXTRA_FREE_TEXT, false))
        }
        if (text.isEmpty() && choice == 0) return
        val graph = context.graph
        val pending = goAsync()
        graph.scope.launch {
            try {
                // A reply only goes to the office it came from, never to one switched to since.
                val here = graph.store.snapshot.value.active?.id == officeId
                if (shown == null) {
                    val ok = here && graph.connection.sendWhenConnected(ClientMsg.prompt(workerId, text), timeoutMs = 8_000)
                    graph.alerts.replied(workerId, name, text, ok)
                    return@launch
                }
                val digit = if (choice > 0) choice else text.toIntOrNull()?.takeIf { n -> shown.choices.any { it.number == n } }
                val label = digit?.let { d -> "$d · ${shown.choices.first { it.number == d }.label}" } ?: "“$text”"
                val result = if (!here) Answered.Unreachable else withOffice(graph.connection, workerId) {
                    if (digit != null) graph.answers.choose(workerId, shown, digit) else graph.answers.type(workerId, shown, text)
                }
                graph.alerts.answered(workerId, name, label, result)
            } finally {
                pending.finish()
            }
        }
    }

    /** Holds the connection open until the office is in and the worker's screen has come, then runs [block]. */
    private suspend fun withOffice(connection: OfficeConnection, workerId: String, block: suspend () -> Answered): Answered {
        val tag = "answer-$workerId"
        connection.hold(tag)
        try {
            withTimeoutOrNull(10_000) {
                connection.link.first { it.phase == Phase.Connected }
                connection.data.first { it.synced }
                connection.screens.first { it.containsKey(workerId) }
            } ?: return Answered.Unreachable
            return block()
        } finally {
            connection.release(tag)
        }
    }

    companion object {
        const val KEY_TEXT = "reply"
        const val EXTRA_OFFICE = "office"
        const val EXTRA_WORKER = "worker"
        const val EXTRA_NAME = "name"
        const val EXTRA_CHOICE = "choice"
        const val EXTRA_QUESTION = "question"
        const val EXTRA_LABELS = "labels"
        const val EXTRA_FREE_TEXT = "free_text"
        private val ID = Regex("^[A-Za-z0-9_\\-:.]{1,64}$")
    }
}
