package ai.factory.droidoffice.notify

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
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
 * Watches the office for droids that start waiting on the owner (a question or permission prompt)
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
    /** What each droid's notification says, so it can be brought up to date without buzzing again. */
    private val shown = HashMap<String, String>()

    init {
        createChannels()
        scope.launch { connection.data.collect(::diff) }
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
            val prev = last.put(w.id, w.state)
            val wasAcked = acked.put(w.id, w.acked)
            if (prev == null) continue
            if (w.state != prev) {
                when {
                    w.state == WorkerStatus.NeedsInput && settings.notifyNeedsInput -> alert(w, d)
                    w.state == WorkerStatus.Done && prev.busy && settings.notifyDone -> alert(w, d)
                    else -> cancel(w.id)
                }
            } else if (w.acked && wasAcked == false) {
                // Someone opened its terminal (here or at the laptop): the alert is answered.
                cancel(w.id)
            } else if (w.id in shown && shown[w.id] != text(w)) {
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

    private fun alert(w: WorkerInfo, d: OfficeData, update: Boolean = false) {
        val needs = w.state == WorkerStatus.NeedsInput
        if (update && !showing(notificationId(w.id))) {
            shown.remove(w.id)
            return
        }
        if (visibility.foreground.value && !update) {
            if (visibility.viewing.value != w.id) _banners.tryEmit(Banner(w.id, w.name, w.color, needs, Workers.detail(w)))
            return
        }
        if (!canNotify()) return
        val officeId = d.officeId ?: return
        val officeName = store.snapshot.value.offices.firstOrNull { it.id == officeId }?.name
        val title = if (needs) "${w.name} needs you" else "${w.name} is done"
        val detail = text(w)
        val builder = NotificationCompat.Builder(context, if (needs) CHANNEL_INPUT else CHANNEL_DONE)
            .setSmallIcon(R.drawable.ic_glyph)
            .setColor(ACCENT)
            .setContentTitle(title)
            .setContentText(detail)
            .setStyle(NotificationCompat.BigTextStyle().bigText(detail))
            .setSubText(listOfNotNull(officeName, d.floor?.name).joinToString(" · "))
            .setCategory(if (needs) NotificationCompat.CATEGORY_MESSAGE else NotificationCompat.CATEGORY_STATUS)
            .setPriority(if (needs) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setOnlyAlertOnce(update)
            .setGroup("office-$officeId")
            // The system's guesses ("Open link" for a file name in a prompt) only get in the way of a reply.
            .setAllowSystemGeneratedContextualActions(false)
            .setContentIntent(openWorker(officeId, w.id))
        if (!w.isGuest) builder.addAction(replyAction(officeId, w))
        post(notificationId(w.id), builder.build())
        shown[w.id] = detail
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
            .setSmallIcon(R.drawable.ic_glyph)
            .setColor(ACCENT)
            .setContentTitle("$floorName: $waiting waiting on you")
            .setContentText("A droid on another floor needs an answer")
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        post(notificationId("floor:$floorId"), n)
    }

    private fun replyAction(officeId: String, w: WorkerInfo): NotificationCompat.Action {
        val remote = RemoteInput.Builder(ReplyReceiver.KEY_TEXT).setLabel("Reply to ${w.name}").build()
        val intent = Intent(context, ReplyReceiver::class.java).apply {
            putExtra(ReplyReceiver.EXTRA_OFFICE, officeId)
            putExtra(ReplyReceiver.EXTRA_WORKER, w.id)
            putExtra(ReplyReceiver.EXTRA_NAME, w.name)
        }
        // Mutable so the system can attach the typed reply; the explicit component keeps it ours.
        val pending = PendingIntent.getBroadcast(context, notificationId(w.id), intent, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Action.Builder(R.drawable.ic_glyph, "Reply", pending)
            .addRemoteInput(remote)
            .setAllowGeneratedReplies(true)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .build()
    }

    private fun openWorker(officeId: String, workerId: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            action = MainActivity.ACTION_OPEN_WORKER
            putExtra(MainActivity.EXTRA_OFFICE, officeId)
            putExtra(MainActivity.EXTRA_WORKER, workerId)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        return PendingIntent.getActivity(context, notificationId(workerId), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /** Shown after a direct reply went out, then cleared. */
    fun replied(workerId: String, name: String, text: String, ok: Boolean) {
        shown.remove(workerId)
        if (!canNotify()) return
        val n = NotificationCompat.Builder(context, CHANNEL_INPUT)
            .setSmallIcon(R.drawable.ic_glyph)
            .setColor(ACCENT)
            .setContentTitle(if (ok) "Sent to $name" else "Couldn't reach the office")
            .setContentText(if (ok) text else "Your reply to $name wasn't sent. Open the app to try again.")
            .setSilent(true)
            .setTimeoutAfter(if (ok) 4_000 else 30_000)
            .setContentIntent(openWorker(connection.data.value.officeId.orEmpty(), workerId))
            .build()
        post(notificationId(workerId), n)
    }

    fun cancel(workerId: String) {
        shown.remove(workerId)
        manager.cancel(notificationId(workerId))
    }

    private fun showing(id: Int) = runCatching { context.getSystemService(NotificationManager::class.java).activeNotifications.any { it.id == id } }.getOrDefault(false)

    /** The owner can turn notifications off (or take the permission back) at any moment, so a post may still be refused. */
    private fun post(id: Int, n: Notification) {
        if (!canNotify()) return
        try {
            manager.notify(id, n)
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
