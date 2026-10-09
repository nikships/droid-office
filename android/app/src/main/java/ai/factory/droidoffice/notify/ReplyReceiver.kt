package ai.factory.droidoffice.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.graph
import kotlinx.coroutines.launch

/** A direct reply typed into a droid's notification: sent to it as a prompt, like the composer does. */
class ReplyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY_TEXT)?.toString()?.trim().orEmpty()
        val workerId = intent.getStringExtra(EXTRA_WORKER)?.takeIf { ID.matches(it) } ?: return
        val officeId = intent.getStringExtra(EXTRA_OFFICE).orEmpty()
        val name = intent.getStringExtra(EXTRA_NAME)?.take(40) ?: "the droid"
        if (text.isEmpty()) return
        val graph = context.graph
        val pending = goAsync()
        graph.scope.launch {
            try {
                // A reply only goes to the office it came from, never to one switched to since.
                val ok = graph.store.snapshot.value.active?.id == officeId && graph.connection.sendWhenConnected(ClientMsg.prompt(workerId, text), timeoutMs = 8_000)
                graph.alerts.replied(workerId, name, text, ok)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val KEY_TEXT = "reply"
        const val EXTRA_OFFICE = "office"
        const val EXTRA_WORKER = "worker"
        const val EXTRA_NAME = "name"
        private val ID = Regex("^[A-Za-z0-9_\\-:.]{1,64}$")
    }
}
