package ai.factory.droidoffice.rn

import ai.factory.droidoffice.core.HostLinkState
import ai.factory.droidoffice.core.HostLog
import ai.factory.droidoffice.core.OfficeJson
import ai.factory.droidoffice.core.OwnedHolds
import ai.factory.droidoffice.core.ToolPolicy
import ai.factory.droidoffice.core.WbFetched
import ai.factory.droidoffice.net.OfficeApi
import ai.factory.droidoffice.session.OfficeConnection
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.os.Looper
import androidx.core.net.toUri
import java.io.IOException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * [ManagementHost] over the app's one [OfficeConnection]. A join sees the open socket's replay, then
 * its frames in order; a new socket (or none) is a new link. Its worker attachments are its own
 * [OwnedHolds], so closing it, or a link change, lets go of exactly those.
 */
class OfficeBridge(private val context: Context, private val connection: OfficeConnection, private val api: OfficeApi) : ManagementHost {
    override fun join(listener: ManagementListener): ManagementJoin {
        check(Looper.myLooper() == Looper.getMainLooper()) { "join on the main thread" }
        val holds = OwnedHolds(connection.sharedHolds)
        var link = current()
        var open = true
        val unsubscribe = connection.listenLog { e ->
            if (!open) return@listenLog
            when (e) {
                is HostLog.Event.Link -> if (e.link.phase != HostLinkState.CONNECTED && link != null) {
                    holds.release()
                    link = null
                    listener.onLink(null, emptyList())
                }
                is HostLog.Event.Message -> {
                    if (link?.epoch == e.epoch && e.frame.t != "welcome") {
                        listener.onFrame(e.epoch, e.frame.text)
                        return@listenLog
                    }
                    // A welcome starts the page over: the replay now holds it, and nothing older.
                    val next = current()
                    if (next == link && e.frame.t != "welcome") return@listenLog
                    holds.release()
                    link = next
                    listener.onLink(next, if (next != null) connection.log.replay.snapshot() else emptyList())
                }
            }
        }
        val replay = if (link != null) connection.log.replay.snapshot() else emptyList()
        return ManagementJoin(
            link = link,
            replay = replay,
            send = send@{ epoch, json ->
                if (!open || link?.epoch != epoch || connection.liveEpoch != epoch) return@send false
                val msg = runCatching { OfficeJson.parseToJsonElement(json) as? JsonObject }.getOrNull() ?: return@send false
                val t = (msg["t"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: return@send false
                when (t) {
                    "floor.go" -> false
                    "worker.attach", "worker.detach" -> {
                        val id = (msg["workerId"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { ID.matches(it) } ?: return@send false
                        if (t == "worker.attach") holds.attach(id) else holds.detach(id)
                        true
                    }
                    else -> connection.send(json)
                }
            },
            close = {
                if (open) {
                    open = false
                    unsubscribe()
                    holds.release()
                }
            },
        )
    }

    /** The active office's live socket, once its welcome is in the replay. */
    private fun current(): ManagementLink? {
        val epoch = connection.log.welcomed ?: return null
        val office = connection.log.link.office ?: return null
        if (connection.liveEpoch != epoch || connection.log.link.phase != HostLinkState.CONNECTED) return null
        return ManagementLink(office, epoch)
    }

    override suspend fun http(officeId: String, epoch: Long, request: ToolHttpRequest): Result<ToolHttpResponse> {
        if (!ToolPolicy.allowed(request.method, request.path) || !ToolPolicy.validQuery(request.query) || !ToolPolicy.validContentType(request.contentType)) {
            return Result.failure(IOException("The phone doesn't send that request to the office."))
        }
        val limit = if (request.contentType?.substringBefore(';')?.trim()?.lowercase()?.let { it == "application/json" || it.endsWith("+json") } != false) ToolPolicy.JSON_MAX else ToolPolicy.UPLOAD_MAX
        if ((request.body?.size ?: 0) > limit) return Result.failure(IOException("That is too much to send at once."))
        val endpoint = connection.bound(officeId, epoch) ?: return Result.failure(IOException(GONE))
        return api.tool(endpoint.base, endpoint.auth, request.method, request.path, request.query, request.contentType, request.body).mapCatching { r ->
            // An answer that arrives after the office or its socket changed belongs to neither.
            if (connection.bound(officeId, epoch) == null) throw IOException(GONE)
            ToolHttpResponse(r.code, r.type, r.body)
        }
    }

    override fun fetch(officeId: String, epoch: Long, path: String, query: String?): WbFetched? {
        if (!ToolPolicy.passthrough(path) || !ToolPolicy.validQuery(query)) return null
        val endpoint = connection.bound(officeId, epoch) ?: return null
        return api.toolFile(endpoint.base, endpoint.auth, path, query)?.takeIf { connection.bound(officeId, epoch) != null }
    }

    override fun openExternal(url: String) {
        if (!ToolPolicy.isExternalUrl(url)) return
        val intent = Intent(Intent.ACTION_VIEW, url.toUri()).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            // Nothing on the phone opens web links: nothing to do.
        }
    }

    private companion object {
        const val GONE = "The office or its connection changed. Open the tool again."
        val ID = Regex("^[A-Za-z0-9_\\-:.]{1,64}$")
    }
}
