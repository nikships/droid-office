package ai.factory.droidoffice.notify

import ai.factory.droidoffice.core.Asks
import ai.factory.droidoffice.core.Choice
import ai.factory.droidoffice.core.Menu
import ai.factory.droidoffice.core.NotificationTarget
import ai.factory.droidoffice.session.Answered

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import ai.factory.droidoffice.AppVisibility
import ai.factory.droidoffice.MainActivity
import ai.factory.droidoffice.R
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.core.WorkerStatus
import ai.factory.droidoffice.core.Workers
import ai.factory.droidoffice.data.OfficeStore
import ai.factory.droidoffice.data.displayName
import ai.factory.droidoffice.session.OfficeConnection
import ai.factory.droidoffice.session.OfficeData
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch

/** An alert the app shows in place of a notification while it's on screen. */
data class Banner(val workerId: String, val name: String, val color: String, val needsInput: Boolean, val detail: String?)

/**
 * Watches the office for workers that start waiting on the owner (a question or permission prompt)
 * or finish a turn, and tells the owner: a notification with a direct reply when the app is in the
 * background, a banner when it's on screen, and nothing for the terminal they're already looking at.
 */
class Alerts(
    private val context: Context,
    scope: CoroutineScope,
    private val connection: OfficeConnection,
    private val store: OfficeStore,
    private val visibility: AppVisibility,
) {
    private val manager = NotificationManagerCompat.from(context)
    private val _banners = MutableSharedFlow<Banner>(extraBufferCapacity = 8)
    val banners: SharedFlow<Banner> = _banners.asSharedFlow()

    private var baseline: Pair<String?, String?>? = null
    private val last = HashMap<String, WorkerStatus>()
    private val acked = HashMap<String, Boolean>()
    private val floorWaiting = HashMap<String, Int>()
    /** What each worker's notification says, so it can be brought up to date without buzzing again. */
    private val shown = HashMap<NotificationTarget, String>()

    init {
        createChannels()
        scope.launch { connection.data.collect(::diff) }
        // The question's choices come on its screen, often a moment after the status flips: add them, quietly.
        scope.launch {
            connection.screens.collect {
                val d = connection.data.value
                for (target in shown.keys.toList()) {
                    if (target.office != d.officeId || target.floor != d.floorId) continue
                    val w = d.workers[target.worker] ?: continue
                    if (w.state == WorkerStatus.NeedsInput && shown[target] != signature(w)) alert(w, d, update = true)
                }
            }
        }
    }

    private fun diff(d: OfficeData) {
        if (!d.synced) return
        val key = d.officeId to d.floorId
        if (baseline != key) {
            // A new office or floor: what's already waiting there isn't news.
            baseline = key
            last.clear()
            acked.clear()
            d.workers.values.forEach { last[it.id] = it.state; acked[it.id] = it.acked }
            d.floors.forEach { floorWaiting[it.id] = it.waiting }
            return
        }
        val settings = store.snapshot.value.settings
        for (w in d.workers.values) {
            val target = NotificationTarget.parse(d.officeId, d.floorId, w.id)
            val prev = last.put(w.id, w.state)
            val wasAcked = acked.put(w.id, w.acked)
            if (prev == null) continue
            if (w.state != prev) {
                when {
                    w.state == WorkerStatus.NeedsInput && settings.notifyNeedsInput -> alert(w, d)
                    // A subagent's finished turn is its lead's to read, not the owner's.
                    w.state == WorkerStatus.Done && prev.busy && settings.notifyDone && !w.isSubagent -> alert(w, d)
                    else -> cancel(w.id)
                }
            } else if (w.acked && wasAcked == false) {
                // Someone opened its terminal (here or at the laptop): the alert is answered.
                cancel(w.id)
            } else if (target != null && target in shown && shown[target] != signature(w)) {
                // The office fills in what it's asking after the state flips: say it, quietly.
                alert(w, d, update = true)
            }
        }
        for (id in last.keys - d.workers.keys) {
            last.remove(id)
            acked.remove(id)
            cancel(id)
        }
        for (f in d.floors) {
            val before = floorWaiting.put(f.id, f.waiting) ?: continue
            if (f.id != d.floorId && f.waiting > before && settings.notifyNeedsInput) floorAlert(f.id, f.name, f.waiting)
        }
    }

    private fun text(w: WorkerInfo) = Workers.detail(w) ?: if (w.state == WorkerStatus.NeedsInput) "Waiting on an answer" else "Finished its turn"

    /** The question on a waiting worker's screen, when the phone can read it. */
    private fun menu(w: WorkerInfo): Menu? = if (w.state == WorkerStatus.NeedsInput) Asks.menu(w, connection.screens.value[w.id]) else null

    /** What its notification says: brought up to date when this changes. */
    private fun signature(w: WorkerInfo): String {
        val m = menu(w) ?: return text(w)
        return (listOf(m.question.orEmpty()) + m.choices.map { "${it.number}${it.label}" }).joinToString("\u0000")
    }

    private fun alert(w: WorkerInfo, d: OfficeData, update: Boolean = false) {
        val target = NotificationTarget.parse(d.officeId, d.floorId, w.id) ?: return
        val needs = w.state == WorkerStatus.NeedsInput
        if (update && !showing(notificationId(w.id), target.key)) {
            shown.remove(target)
            return
        }
        if (visibility.foreground.value && !update) {
            if (visibility.viewing.value != w.id) _banners.tryEmit(Banner(w.id, w.name, w.color, needs, Workers.detail(w)))
            return
        }
        if (!canNotify()) return
        val officeId = d.officeId ?: return
        val officeName = store.snapshot.value.offices.firstOrNull { it.id == officeId }?.displayName
        val title = if (needs) "${w.name} needs you" else "${w.name} is done"
        val menu = menu(w)
        val detail = menu?.question ?: text(w)
        val big = if (menu == null) detail else (listOf(detail, "") + menu.choices.map { c -> "${c.number}. ${c.label}" + (c.description?.let { " · $it" } ?: "") }).joinToString("\n")
        val builder = NotificationCompat.Builder(context, if (needs) CHANNEL_INPUT else CHANNEL_DONE)
            .setSmallIcon(R.drawable.ic_bolt)
            .setColor(ACCENT)
            .setContentTitle(title)
            .setContentText(detail)
            .setStyle(NotificationCompat.BigTextStyle().bigText(big))
            .setSubText(listOfNotNull(officeName, d.floor?.name).joinToString(" · "))
            .setCategory(if (needs) NotificationCompat.CATEGORY_MESSAGE else NotificationCompat.CATEGORY_STATUS)
            .setPriority(if (needs) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setOnlyAlertOnce(update)
            .setGroup("office-$officeId")
            // The system's guesses ("Open link" for a file name in a prompt) only get in the way of a reply.
            .setAllowSystemGeneratedContextualActions(false)
            .setContentIntent(openWorker(target))
        if (!w.isGuest && menu?.multiSelect != true) {
            // Up to three buttons: its first two choices, then Reply, which takes a digit or your own answer.
            menu?.choices?.take(2)?.forEach { c -> builder.addAction(choiceAction(target, w, menu, c)) }
            builder.addAction(replyAction(target, w, menu))
        }
        post(notificationId(w.id), builder.build(), target.key)
        shown[target] = signature(w)
    }

    private fun floorAlert(floorId: String, floorName: String, waiting: Int) {
        if (visibility.foreground.value || !canNotify()) return
        val officeId = connection.data.value.officeId ?: return
        val intent = Intent(context, MainActivity::class.java).apply {
            action = MainActivity.ACTION_OPEN_FLOOR
            putExtra(MainActivity.EXTRA_OFFICE, officeId)
            putExtra(MainActivity.EXTRA_FLOOR, floorId)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pending = PendingIntent.getActivity(context, floorId.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(context, CHANNEL_INPUT)
            .setSmallIcon(R.drawable.ic_bolt)
            .setColor(ACCENT)
            .setContentTitle("$floorName: $waiting waiting on you")
            .setContentText("A worker on another floor needs an answer")
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        post(notificationId("floor:$floorId"), n)
    }

    private fun replyIntent(target: NotificationTarget, w: WorkerInfo, menu: Menu?) = Intent(context, ReplyReceiver::class.java).apply {
        data = Uri.parse("droidoffice://notification/${target.key}/reply")
        putExtra(ReplyReceiver.EXTRA_OFFICE, target.office)
        putExtra(ReplyReceiver.EXTRA_FLOOR, target.floor)
        putExtra(ReplyReceiver.EXTRA_WORKER, target.worker)
        putExtra(ReplyReceiver.EXTRA_NAME, w.name)
        if (menu != null) {
            putExtra(ReplyReceiver.EXTRA_MENU, ai.factory.droidoffice.core.OfficeJson.encodeToString(Menu.serializer(), menu))
            putExtra(ReplyReceiver.EXTRA_QUESTION, menu.question)
            putStringArrayListExtra(ReplyReceiver.EXTRA_LABELS, ArrayList(menu.choices.map { it.label }))
            putExtra(ReplyReceiver.EXTRA_FREE_TEXT, menu.freeText)
        }
    }

    /** "1 · Wait for the drawer": answers with that choice, once the screen still shows the question. */
    private fun choiceAction(target: NotificationTarget, w: WorkerInfo, menu: Menu, c: Choice): NotificationCompat.Action {
        val intent = replyIntent(target, w, menu).putExtra(ReplyReceiver.EXTRA_CHOICE, c.number).apply {
            data = Uri.parse("droidoffice://notification/${target.key}/choice/${c.number}")
        }
        val pending = PendingIntent.getBroadcast(context, notificationId(w.id) + c.number, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Action.Builder(R.drawable.ic_bolt, Asks.buttonLabel(c), pending)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_NONE)
            .setShowsUserInterface(false)
            .build()
    }

    private fun replyAction(target: NotificationTarget, w: WorkerInfo, menu: Menu?): NotificationCompat.Action {
        val remote = RemoteInput.Builder(ReplyReceiver.KEY_TEXT).setLabel(if (menu != null) "A number, or your own answer" else "Reply to ${w.name}").build()
        val intent = replyIntent(target, w, menu)
        // Mutable so the system can attach the typed reply; the explicit component keeps it ours.
        val pending = PendingIntent.getBroadcast(context, notificationId(w.id), intent, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Action.Builder(R.drawable.ic_bolt, "Reply", pending)
            .addRemoteInput(remote)
            .setAllowGeneratedReplies(true)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .build()
    }

    private fun openWorker(target: NotificationTarget): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            action = MainActivity.ACTION_OPEN_WORKER
            data = Uri.parse("droidoffice://notification/${target.key}/open")
            putExtra(MainActivity.EXTRA_OFFICE, target.office)
            putExtra(MainActivity.EXTRA_WORKER, target.worker)
            putExtra(MainActivity.EXTRA_FLOOR, target.floor)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        return PendingIntent.getActivity(context, notificationId(target.worker), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /** Shown after a direct reply went out, then cleared. */
    fun replied(target: NotificationTarget, name: String, text: String, ok: Boolean) {
        shown.remove(target)
        if (!canNotify()) return
        val n = NotificationCompat.Builder(context, CHANNEL_INPUT)
            .setSmallIcon(R.drawable.ic_bolt)
            .setColor(ACCENT)
            .setContentTitle(if (ok) "Sent to $name" else "Couldn't reach the office")
            .setContentText(if (ok) text else "Your reply to $name wasn't sent. Open the app to try again.")
            .setSilent(true)
            .setTimeoutAfter(if (ok) 4_000 else 30_000)
            .setContentIntent(openWorker(target))
            .build()
        post(notificationId(target.worker), n, target.key)
    }

    /** Shown after a choice from the notification: sent, or why it wasn't. */
    fun answered(target: NotificationTarget, name: String, label: String, result: Answered) {
        shown.remove(target)
        if (!canNotify()) return
        val (title, text) = when (result) {
            Answered.Sent -> "Sent to $name" to label
            Answered.Changed -> "$name's question changed" to "Nothing was sent. Open it to see the new question."
            Answered.NeedsThread -> "Answer $name in the app" to "The phone couldn't type that into its question. Nothing was sent."
            Answered.Unreachable -> "Couldn't reach the office" to "Your answer to $name wasn't sent. Open the app to try again."
            Answered.Unconfirmed -> "Answer not confirmed" to "Check $name's terminal before trying again. Your answer was not replayed."
            Answered.Refused -> "Answer refused" to "Open $name in the app and check Raw TTY."
        }
        val n = NotificationCompat.Builder(context, CHANNEL_INPUT)
            .setSmallIcon(R.drawable.ic_bolt)
            .setColor(ACCENT)
            .setContentTitle(title)
            .setContentText(text)
            .setSilent(true)
            .setTimeoutAfter(if (result == Answered.Sent) 4_000 else 30_000)
            .setContentIntent(openWorker(target))
            .build()
        post(notificationId(target.worker), n, target.key)
    }

    fun cancel(workerId: String) {
        val d = connection.data.value
        val target = NotificationTarget.parse(d.officeId, d.floorId, workerId) ?: return
        shown.remove(target)
        manager.cancel(target.key, notificationId(workerId))
    }

    private fun showing(id: Int, tag: String) = runCatching { context.getSystemService(NotificationManager::class.java).activeNotifications.any { it.id == id && it.tag == tag } }.getOrDefault(false)

    /** The owner can turn notifications off (or take the permission back) at any moment, so a post may still be refused. */
    private fun post(id: Int, n: Notification, tag: String? = null) {
        if (!canNotify()) return
        try {
            manager.notify(tag, id, n)
        } catch (_: SecurityException) {
        }
    }

    fun canNotify(): Boolean {
        val granted = Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        return granted && manager.areNotificationsEnabled()
    }

    private fun createChannels() {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannels(
            listOf(
                NotificationChannel(CHANNEL_INPUT, context.getString(R.string.channel_needs_input), NotificationManager.IMPORTANCE_HIGH).apply {
                    description = context.getString(R.string.channel_needs_input_desc)
                },
                NotificationChannel(CHANNEL_DONE, context.getString(R.string.channel_done), NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = context.getString(R.string.channel_done_desc)
                },
                NotificationChannel(CHANNEL_CONNECTION, context.getString(R.string.channel_connection), NotificationManager.IMPORTANCE_MIN).apply {
                    description = context.getString(R.string.channel_connection_desc)
                    setShowBadge(false)
                },
            ),
        )
    }

    companion object {
        const val CHANNEL_INPUT = "needs_input"
        const val CHANNEL_DONE = "done"
        const val CHANNEL_CONNECTION = "connection"
        const val ACCENT = 0xFFEE6018.toInt()
        fun notificationId(key: String) = 1000 + (key.hashCode() and 0x3fffffff)
    }
}
