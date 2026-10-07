package ai.factory.droidoffice.notify

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import ai.factory.droidoffice.MainActivity
import ai.factory.droidoffice.R
import ai.factory.droidoffice.core.WorkerStatus
import ai.factory.droidoffice.graph
import ai.factory.droidoffice.session.Phase
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/**
 * The opt-in "stay connected" mode: a foreground service that holds the office connection while the
 * app is in the background, so [Alerts] can tell the owner the moment a worker needs them. The office
 * has no push channel, so an open socket is the only way to hear.
 */
class StayConnectedService : LifecycleService() {
    private var started = false

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        if (intent?.action == ACTION_STOP) {
            lifecycleScope.launch {
                graph.store.settings { it.copy(stayConnected = false) }
                stopSelf()
            }
            return START_NOT_STICKY
        }
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification("Connecting…"),
            if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0,
        )
        if (!started) {
            started = true
            graph.connection.hold(HOLD)
            lifecycleScope.launch {
                combine(graph.connection.link, graph.connection.data, graph.store.snapshot) { link, data, store ->
                    val office = store.active?.name ?: "the office"
                    when (link.phase) {
                        Phase.Connected -> {
                            val workers = data.workers.values.filterNot { it.isStation }
                            val waiting = workers.count { it.state == WorkerStatus.NeedsInput }
                            val working = workers.count { it.state == WorkerStatus.Working || it.state == WorkerStatus.Starting }
                            val route = link.kind?.label ?: "LAN"
                            buildString {
                                append("$office via $route")
                                if (working > 0) append(" · $working working")
                                if (waiting > 0) append(" · $waiting need you")
                            }
                        }
                        Phase.Unauthorized -> "$office: pair again to reconnect"
                        Phase.Offline -> "Waiting for a network"
                        else -> "Reaching $office…"
                    }
                }.distinctUntilChanged().collect { text ->
                    ContextCompat.getSystemService(this@StayConnectedService, android.app.NotificationManager::class.java)
                        ?.notify(NOTIFICATION_ID, notification(text))
                }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        if (started) graph.connection.release(HOLD)
        super.onDestroy()
    }

    private fun notification(text: String) = NotificationCompat.Builder(this, Alerts.CHANNEL_CONNECTION)
        .setSmallIcon(R.drawable.ic_glyph)
        .setColor(Alerts.ACCENT)
        .setContentTitle("Staying connected")
        .setContentText(text)
        .setOngoing(true)
        .setSilent(true)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .setContentIntent(
            PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE),
        )
        .addAction(
            R.drawable.ic_glyph,
            "Disconnect",
            PendingIntent.getService(this, 1, Intent(this, StayConnectedService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE),
        )
        .build()

    companion object {
        private const val NOTIFICATION_ID = 7
        private const val HOLD = "service"
        private const val ACTION_STOP = "ai.factory.droidoffice.STOP_STAYING"

        /** Only from the foreground: Android doesn't let a backgrounded app start one. */
        fun start(context: Context) {
            runCatching { ContextCompat.startForegroundService(context, Intent(context, StayConnectedService::class.java)) }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, StayConnectedService::class.java))
        }
    }
}
