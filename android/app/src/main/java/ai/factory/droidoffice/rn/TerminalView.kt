package ai.factory.droidoffice.rn

import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.HostLog
import ai.factory.droidoffice.core.PageMsg
import ai.factory.droidoffice.core.PhoneSizing
import ai.factory.droidoffice.core.QuickKey
import ai.factory.droidoffice.core.QuickKeys
import ai.factory.droidoffice.core.TermPage
import ai.factory.droidoffice.core.TermSize
import ai.factory.droidoffice.core.TermView
import ai.factory.droidoffice.graph
import ai.factory.droidoffice.ui.worker.TerminalPage
import android.content.Context
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout

/**
 * A worker's raw terminal for the React Native workspace: the xterm page ([TerminalPage]) and its
 * native keyboard and quick keys, on the app's one connection. It holds the worker while mounted. It types and
 * resizes the shared PTY only while it is the [active] pane, laid out at a non-zero size, and showing
 * a snapshot from the socket that is live now; a hidden or inactive pane follows the PTY's size.
 */
class TerminalView(context: Context) : FrameLayout(context) {
    private val graph = context.applicationContext.graph
    private val connection = graph.connection
    private val tokens = graph.host.tokens

    var workerId: String? = null
        private set
    private var active = false
    private var phone = true
    private var token = 0L
    private var tokenGeneration = -1L
    private var page: TerminalPage? = null
    private var listening: ((ai.factory.droidoffice.core.TermEvent) -> Unit)? = null

    /** The socket whose snapshot the page shows; input is refused until it is the live one. */
    private var drawnEpoch: Long? = null
    private var fit: TermSize? = null
    private val sizing = PhoneSizing()
    private var unlisten: (() -> Unit)? = null
    private val settle = Runnable { resize() }
    private val keys = QuickKeyBar(context, ::key) { if (canType()) page?.showKeyboard() }

    init {
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        contentDescription = "Terminal"
        addView(keys, LayoutParams(LayoutParams.MATCH_PARENT, dp(QuickKeyBar.HEIGHT_DP), Gravity.BOTTOM))
    }

    fun setWorker(id: String?) {
        val next = id?.takeIf { NativeHost.ID.matches(it) }
        if (next == workerId) return
        stop()
        workerId = next
        if (isAttachedToWindow) start()
    }

    fun setActive(on: Boolean) {
        if (on == active) return
        active = on
        // Alerts stay quiet about the worker whose terminal is the active pane.
        val viewing = graph.visibility.viewing
        if (on) workerId?.let { viewing.value = it } else if (viewing.value == workerId) viewing.value = null
        if (!on) restore()
        typing()
        resizeSoon()
    }

    fun setFit(value: String?) {
        val p = value != "desktop"
        if (p == phone) return
        phone = p
        if (!p) restore()
        page?.send(TermPage.view(view()))
        resizeSoon()
    }

    private fun view() = if (phone) TermView.Phone else TermView.Desktop

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        start()
    }

    override fun onDetachedFromWindow() {
        stop()
        super.onDetachedFromWindow()
    }

    fun dispose() = stop()

    private fun start() {
        val id = workerId ?: return
        if (page != null) return
        hold(id)
        unlisten = connection.listenLog(::onLog)
        newPage(id)
    }

    private fun hold(id: String) {
        if (token != 0L && tokenGeneration == connection.holdGeneration) return
        if (token != 0L) tokens.release(token)
        tokenGeneration = connection.holdGeneration
        token = tokens.hold(id)
    }

    private fun newPage(id: String) {
        lateinit var p: TerminalPage
        p = TerminalPage(context, onMessage = { msg -> onPage(id, p, msg) }, onGone = {
            if (page === p) {
                unfeed()
                p.destroy()
                page = null
                drawnEpoch = null
                newPage(id)
            }
        })
        page = p
        removePage()
        addView(p.view, 0, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT).apply { bottomMargin = dp(QuickKeyBar.HEIGHT_DP) })
        showKeys(id)
    }

    private fun removePage() {
        for (i in childCount - 1 downTo 0) if (getChildAt(i) !== keys) removeViewAt(i)
    }

    /** A shell's row is Tab and its common commands; a droid's is the owner's arranged keys. */
    private fun showKeys(id: String) {
        val shell = connection.data.value.workers[id]?.isShell == true
        keys.show(if (shell) QuickKeys.shell else QuickKeys.arrange(graph.store.snapshot.value.settings.quickKeys))
    }

    private fun key(k: QuickKey) {
        val id = workerId ?: return
        if (canType()) connection.send(ClientMsg.termInput(id, k.bytes))
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun onPage(id: String, p: TerminalPage, msg: PageMsg) {
        if (page !== p || workerId != id) return
        when (msg) {
            PageMsg.Ready -> {
                p.send(TermPage.config(resources.configuration.fontScale, view()))
                feed(id, p)
            }
            PageMsg.Drawn -> {
                drawnEpoch = connection.liveEpoch
                typing()
                resizeSoon()
            }
            is PageMsg.Bottom -> Unit
            is PageMsg.Fit -> {
                fit = msg.size
                resizeSoon()
            }
            is PageMsg.Input -> if (canType()) connection.send(ClientMsg.termInput(id, msg.data))
        }
    }

    private fun feed(id: String, p: TerminalPage) {
        unfeed()
        val f = connection.feed(id)
        listening = p.listener
        if (f == null || !f.listen(p.listener)) connection.resnapshot(id)
    }

    private fun unfeed() {
        val id = workerId ?: return
        listening?.let { connection.feed(id)?.unlisten(it) }
        listening = null
    }

    private fun onLog(e: HostLog.Event) {
        val id = workerId ?: return
        when (e) {
            is HostLog.Event.Link -> {
                drawnEpoch = null
                sizing.disconnected()
                typing()
            }
            is HostLog.Event.Message -> if (e.frame.workerId == id) {
                showKeys(id)
            } else if (e.frame.t == "welcome") {
                // Another office's welcome dropped every attachment: hold again, then hear the fresh snapshot.
                hold(id)
                val p = page ?: return
                if (p.ready) feed(id, p)
            }
        }
    }

    private fun laidOut() = width > 0 && height > 0 && isShown

    private fun canType(): Boolean = active && laidOut() && drawnEpoch != null && drawnEpoch == connection.liveEpoch

    private fun typing() {
        val can = canType()
        page?.typeDirectly(can, show = false)
        keys.enable(can)
    }

    private fun resizeSoon() {
        removeCallbacks(settle)
        // Keyboard and pane animations settle before the shared PTY is resized.
        postDelayed(settle, RESIZE_SETTLE_MS)
    }

    private fun resize() {
        val id = workerId ?: return
        val w = connection.data.value.workers[id] ?: return
        val current = TermSize(w.cols, w.rows)
        if (!phone || !canType() || w.isCloud) return
        if (sizing.takenOver(current)) {
            sizing.release()
            return
        }
        val target = fit ?: return
        sizing.request(current, target)?.let { size ->
            if (connection.send(ClientMsg.termResize(id, size.cols, size.rows))) sizing.sent(size)
        }
    }

    /** Puts back the size the PTY had before this pane resized it, unless another window took it since. */
    private fun restore() {
        val id = workerId ?: return
        val w = connection.data.value.workers[id]
        val back = w?.let { sizing.restore(TermSize(it.cols, it.rows)) }
        if (back == null || connection.send(ClientMsg.termResize(id, back.cols, back.rows))) sizing.release()
    }

    private fun stop() {
        removeCallbacks(settle)
        restore()
        unlisten?.invoke()
        unlisten = null
        unfeed()
        page?.destroy()
        page = null
        drawnEpoch = null
        fit = null
        removePage()
        keys.enable(false)
        if (token != 0L) tokens.release(token)
        token = 0L
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        typing()
        resizeSoon()
    }

    // React Native lays out its own views only; a native child has to be measured and placed here.
    private fun relayoutPending() {
        post {
            measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
            layout(left, top, right, bottom)
        }
    }

    override fun requestLayout() {
        super.requestLayout()
        // Called by the FrameLayout constructor too, before this class's fields exist.
        relayoutPending()
    }

    private companion object {
        const val RESIZE_SETTLE_MS = 150L
    }
}
