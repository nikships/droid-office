package ai.factory.droidoffice.notify

import ai.factory.droidoffice.core.Choice
import ai.factory.droidoffice.core.Menu
import ai.factory.droidoffice.core.NotificationTarget
import ai.factory.droidoffice.core.QuestionAnswers
import ai.factory.droidoffice.session.Answered

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
        val target = NotificationTarget.parse(
            intent.getStringExtra(EXTRA_OFFICE), intent.getStringExtra(EXTRA_FLOOR), intent.getStringExtra(EXTRA_WORKER),
        ) ?: return
        val workerId = target.worker
        val name = intent.getStringExtra(EXTRA_NAME)?.take(40) ?: "the worker"
        val choice = intent.getIntExtra(EXTRA_CHOICE, 0)
        // The question the notification showed, to check against the screen before anything is typed.
        val shown = if (intent.hasExtra(EXTRA_MENU)) intent.getStringExtra(EXTRA_MENU)?.takeIf { it.length <= 64 * 1024 }?.let { encoded ->
            runCatching { ai.factory.droidoffice.core.OfficeJson.decodeFromString(Menu.serializer(), encoded) }.getOrNull()
        } else intent.getStringArrayListExtra(EXTRA_LABELS)?.takeIf { it.size >= 2 }?.let { labels ->
            Menu(intent.getStringExtra(EXTRA_QUESTION), labels.mapIndexed { i, l -> Choice(i + 1, l) }, null, intent.getBooleanExtra(EXTRA_FREE_TEXT, false))
        }
        val hadMenu = intent.hasExtra(EXTRA_MENU) || intent.hasExtra(EXTRA_LABELS)
        if (choice < 0 || (text.isEmpty() && choice == 0)) return
        val graph = context.graph
        val pending = goAsync()
        graph.scope.launch {
            val hold = "notification-${System.nanoTime()}"
            var held = false
            try {
                // Never wait for a reconnect or floor change and then send an old notification action.
                val connection = graph.connection
                val d = connection.data.value
                val here = target.current(
                    graph.store.snapshot.value.active?.id, d.officeId, d.floorId,
                    d.synced && connection.connected && connection.liveEpoch != null,
                    d.workers[workerId]?.isGuest == false,
                )
                if (here) {
                    connection.hold(hold)
                    held = true
                }
                if (shown == null) {
                    val ok = here && !hadMenu && choice == 0 && connection.send(ClientMsg.prompt(workerId, text))
                    graph.alerts.replied(target, name, text, ok)
                    return@launch
                }
                val digit = if (choice > 0) choice else text.toIntOrNull()?.takeIf { n -> shown.choices.any { it.number == n } }
                val label = digit?.let { n -> shown.choices.firstOrNull { it.number == n }?.let { "$n · ${it.label}" } } ?: "“$text”"
                val result = when {
                    !here -> Answered.Unreachable
                    !QuestionAnswers.valid(shown, digit, null, text.takeIf { digit == null }) -> Answered.NeedsThread
                    digit != null -> graph.answers.choose(workerId, shown, digit)
                    else -> graph.answers.type(workerId, shown, text)
                }
                graph.alerts.answered(target, name, label, result)
            } finally {
                if (held) graph.connection.release(hold)
                pending.finish()
            }
        }
    }

    companion object {
        const val KEY_TEXT = "reply"
        const val EXTRA_OFFICE = "office"
        const val EXTRA_FLOOR = "floor"
        const val EXTRA_WORKER = "worker"
        const val EXTRA_NAME = "name"
        const val EXTRA_CHOICE = "choice"
        const val EXTRA_QUESTION = "question"
        const val EXTRA_LABELS = "labels"
        const val EXTRA_FREE_TEXT = "free_text"
        const val EXTRA_MENU = "menu"
    }
}
