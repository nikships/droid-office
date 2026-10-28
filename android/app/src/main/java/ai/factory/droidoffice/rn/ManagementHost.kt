package ai.factory.droidoffice.rn

import ai.factory.droidoffice.core.WbFetched

/**
 * What the sealed Management view (the bundled companion-tools page) gets from the app's one
 * connection. The view never sees an address or a token: frames, sends, HTTP and the page's
 * passthrough files all go through here, bound to the office and socket the view joined, so an
 * answer for one office can never land in a page that has since moved to another.
 */
interface ManagementHost {
    /**
     * Atomically, on the main thread: the replay that brings an empty page to now (StateReplay's
     * snapshot as the raw JSON frames, oldest first) and a subscription to every later frame and link
     * change, so nothing is missed or applied twice. Call [ManagementJoin.close] when the view goes.
     */
    fun join(listener: ManagementListener): ManagementJoin

    /**
     * Forwards one request to [officeId] with the device's credential, only while it is still the
     * active office on socket [epoch]; the policy (ToolPolicy) is checked again here. Fails with the
     * reason as a sentence when refused or unreachable.
     */
    suspend fun http(officeId: String, epoch: Long, request: ToolHttpRequest): Result<ToolHttpResponse>

    /**
     * A passthrough GET (pictures, fonts, card frames: TOOL_PASSTHROUGH_PREFIXES) for the page's
     * WebView, on its own thread. Blocking; null once [officeId] or [epoch] no longer holds.
     */
    fun fetch(officeId: String, epoch: Long, path: String, query: String?): WbFetched?

    /** Opens an https link outside the app (isExternalUrl already checked by the caller and here). */
    fun openExternal(url: String)
}

/** Where a joined view stands: the active office and its welcomed socket, or null while down. */
data class ManagementLink(val officeId: String, val epoch: Long)

interface ManagementListener {
    /** One frame from socket [epoch], in order, on the main thread. */
    fun onFrame(epoch: Long, json: String)

    /** The socket went down ([link] null) or a new one welcomed, on the main thread. A new link means a new replay. */
    fun onLink(link: ManagementLink?, replay: List<String>)
}

/**
 * One view's join. [send] sends a ClientMsg (JSON text) now on socket epoch, or returns false: when
 * that socket is gone, the message isn't one, or it is a `floor.go` (the workspace alone moves the
 * connection). Never queued, never replayed. The join's `worker.attach`/`worker.detach` are holds of
 * its own on the app's shared attachments: [close] (or a new link) releases exactly those, never
 * another view's or another join's.
 */
class ManagementJoin(val link: ManagementLink?, val replay: List<String>, val send: (epoch: Long, json: String) -> Boolean, val close: () -> Unit)

class ToolHttpRequest(val method: String, val path: String, val query: String?, val contentType: String?, val body: ByteArray?)

class ToolHttpResponse(val status: Int, val contentType: String?, val body: ByteArray)
