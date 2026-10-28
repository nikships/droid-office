package ai.factory.droidoffice.session

import ai.factory.droidoffice.core.Backoff
import ai.factory.droidoffice.core.OfficeEndpoint
import ai.factory.droidoffice.core.HostUpdateAction
import ai.factory.droidoffice.core.HostUpdateState
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.DroidCommand
import ai.factory.droidoffice.core.FloorInfo
import ai.factory.droidoffice.core.FloorView
import ai.factory.droidoffice.core.Frame
import ai.factory.droidoffice.core.HostLinkState
import ai.factory.droidoffice.core.HostLog
import ai.factory.droidoffice.core.GhPull
import ai.factory.droidoffice.core.ModelAvailability
import ai.factory.droidoffice.core.Probe
import ai.factory.droidoffice.core.ProjectInfo
import ai.factory.droidoffice.core.Protocol
import ai.factory.droidoffice.core.RaceResult
import ai.factory.droidoffice.core.RouteKind
import ai.factory.droidoffice.core.RouteRacer
import ai.factory.droidoffice.core.Routes
import ai.factory.droidoffice.core.ScreenState
import ai.factory.droidoffice.core.ServerMsg
import ai.factory.droidoffice.core.TermEvent
import ai.factory.droidoffice.core.TermFeed
import ai.factory.droidoffice.core.TermSize
import ai.factory.droidoffice.core.WbFetched
import ai.factory.droidoffice.core.WbFileRef
import ai.factory.droidoffice.core.WbFloor
import ai.factory.droidoffice.core.WbPinged
import ai.factory.droidoffice.core.WbRenderStatus
import ai.factory.droidoffice.core.WbResult
import ai.factory.droidoffice.core.WhiteboardSync
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.core.Workers
import ai.factory.droidoffice.data.AuthMode
import ai.factory.droidoffice.data.OfficeStore
import ai.factory.droidoffice.data.PairedOffice
import ai.factory.droidoffice.net.ModelCatalogue
import ai.factory.droidoffice.net.NetworkMonitor
import ai.factory.droidoffice.net.OfficeApi
import ai.factory.droidoffice.net.OfficeAuth
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.transformLatest
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

enum class Phase { Idle, Connecting, Connected, Reconnecting, Offline, Unauthorized }

/** Where the connection to the active office stands, and which route it is on. */
data class Link(
    val phase: Phase = Phase.Idle,
    val officeId: String? = null,
    val base: String? = null,
    val kind: RouteKind? = null,
    val attempt: Int = 0,
    val retryAt: Long? = null,
    val detail: String? = null,
)

/** The floor the phone is on, as the office last described it. */
data class OfficeData(
    val officeId: String? = null,
    val floors: List<FloorInfo> = emptyList(),
    val floorId: String? = null,
    val project: ProjectInfo? = null,
    val workers: Map<String, WorkerInfo> = emptyMap(),
    val pulls: List<GhPull> = emptyList(),
    val version: String? = null,
    /** A welcome has arrived since this office became the active one. */
    val synced: Boolean = false,
) {
    val floor: FloorInfo? get() = floors.firstOrNull { it.id == floorId }
}

private data class Desire(val office: PairedOffice?, val wanted: Boolean, val online: Boolean, val networkKey: String?, val nonce: Int)

private sealed interface SocketEvent {
    data class Text(val text: String) : SocketEvent
    data class Closed(val reason: String, val code: Int) : SocketEvent
    data class Failed(val reason: String, val code: Int?) : SocketEvent
    /** A better route than the one in use answered. */
    data object Upgrade : SocketEvent
}

private data class SessionEnd(val welcomed: Boolean, val reason: String, val unpaired: Boolean = false, val upgrade: Boolean = false)

/**
 * The phone's one live connection, to the active office. It runs while something holds it (the UI
 * in the foreground, the stay-connected service, a notification reply) and for a short grace after,
 * races the office's routes for the fastest one, reconnects with backoff, and re-races whenever the
 * phone's network changes (Wi-Fi to mobile data, joining the tailnet).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class OfficeConnection(
    private val scope: CoroutineScope,
    private val api: OfficeApi,
    private val store: OfficeStore,
    private val network: NetworkMonitor,
    val deviceName: String,
    private val racer: RouteRacer = RouteRacer(),
) {
    private val _link = MutableStateFlow(Link())
    val link: StateFlow<Link> = _link.asStateFlow()

    /**
     * The order the React Native side and management views see this connection in: link changes and
     * every frame of every socket, numbered from one counter. Main thread only.
     */
    val log = HostLog()
    private val logListeners = LinkedHashSet<(HostLog.Event) -> Unit>()

    /** The socket whose welcome has arrived and is still open, readable from any thread; null while down. */
    @Volatile var liveEpoch: Long? = null
        private set

    /** Bumped whenever the active office changes and every attachment is dropped with it. */
    @Volatile var holdGeneration = 0L
        private set

    /** [attach]/[detach] for owners that keep their own books (OwnedHolds, HoldTokens). Any thread. */
    val sharedHolds = object : ai.factory.droidoffice.core.SharedHolds {
        override fun generation() = holdGeneration
        override fun attach(workerId: String) = this@OfficeConnection.attach(workerId)
        override fun detach(workerId: String) = this@OfficeConnection.detach(workerId)
        override fun resnapshot(workerId: String) = this@OfficeConnection.resnapshot(workerId)
    }

    /** Hears every [HostLog] event, in order, on the main thread. Returns the unsubscribe. */
    fun listenLog(listener: (HostLog.Event) -> Unit): () -> Unit {
        logListeners += listener
        return { logListeners -= listener }
    }

    private fun dispatch(e: HostLog.Event) {
        for (l in logListeners.toList()) runCatching { l(e) }
    }

    private var linkValue: Link
        get() = _link.value
        set(value) {
            _link.value = value
            hostLink(value)
        }

    /** What the link says to the React Native side: never an address, only the office's own sentences. */
    private fun hostLink(l: Link) {
        val phase = when (l.phase) {
            Phase.Idle -> HostLinkState.IDLE
            Phase.Connecting, Phase.Reconnecting -> HostLinkState.CONNECTING
            // Connected is announced by the welcome itself (HostLog.frame), before its first message.
            Phase.Connected -> return
            Phase.Offline -> HostLinkState.OFFLINE
            Phase.Unauthorized -> HostLinkState.UNAUTHORIZED
        }
        val reason = if (l.phase == Phase.Offline || l.phase == Phase.Unauthorized) l.detail else null
        log.link(phase, l.officeId, reason)?.let(::dispatch)
    }

    /** The endpoint for [officeId] while socket [epoch] is its live, welcomed one; null otherwise. Any thread. */
    fun bound(officeId: String, epoch: Long): OfficeEndpoint<OfficeAuth>? =
        current?.takeIf { it.officeId == officeId && liveEpoch == epoch && store.snapshot.value.active?.id == officeId }

    private val _data = MutableStateFlow(OfficeData())
    val data: StateFlow<OfficeData> = _data.asStateFlow()

    private val _availability = MutableStateFlow<Map<String, ModelAvailability>>(emptyMap())

    /** Whether each subscription model can run now, by model id; empty from an office that doesn't say. */
    val availability: StateFlow<Map<String, ModelAvailability>> = _availability.asStateFlow()
    private val _hiddenModels = MutableStateFlow<Set<String>>(emptySet())
    val hiddenModels = _hiddenModels.asStateFlow()
    private val _subscriptions = MutableStateFlow<ai.factory.droidoffice.core.SubscriptionState?>(null)
    val subscriptions = _subscriptions.asStateFlow()

    private val _screens = MutableStateFlow<Map<String, ScreenState>>(emptyMap())
    val screens: StateFlow<Map<String, ScreenState>> = _screens.asStateFlow()

    private val _toasts = MutableSharedFlow<ServerMsg.Toast>(extraBufferCapacity = 32)
    val toasts: SharedFlow<ServerMsg.Toast> = _toasts.asSharedFlow()

    private val _worktrees = MutableSharedFlow<ServerMsg.Worktree>(extraBufferCapacity = 8)
    val worktrees: SharedFlow<ServerMsg.Worktree> = _worktrees.asSharedFlow()

    /** A worker this phone just hired arrived at its desk. */
    private val _hired = MutableSharedFlow<WorkerInfo>(extraBufferCapacity = 4)
    val hired: SharedFlow<WorkerInfo> = _hired.asSharedFlow()

    private val _boards = MutableStateFlow<Map<String, WbFloor>>(emptyMap())

    /** Each floor's Whiteboard this connection has a snapshot of, by floor id. */
    val boards: StateFlow<Map<String, WbFloor>> = _boards.asStateFlow()

    private val _pinged = MutableSharedFlow<WbPinged>(extraBufferCapacity = 8)

    /** What became of a Whiteboard ping this phone sent. */
    val pinged: SharedFlow<WbPinged> = _pinged.asSharedFlow()

    private val _threads = MutableSharedFlow<ServerMsg.ThreadSnapshot>(extraBufferCapacity = 16)

    /** Pages of workers' conversations, each answering one `thread.read`; a [ai.factory.droidoffice.core.ThreadFeed] keeps the ones it asked for. */
    val threads: SharedFlow<ServerMsg.ThreadSnapshot> = _threads.asSharedFlow()

    private val boardWatchers = HashSet<String>()
    private var whiteboard = newWhiteboard()

    private val holders = MutableStateFlow<Set<String>>(emptySet())
    private val nonce = MutableStateFlow(0)
    private val attached = ConcurrentHashMap.newKeySet<String>()
    private val holds = HashMap<String, Int>()
    /** Each attached terminal's stream: created on any thread by [attach], pushed on the main thread by [handle]. */
    private val feeds = ConcurrentHashMap<String, TermFeed>()
    @Volatile private var socket: WebSocket? = null
    @Volatile private var current: OfficeEndpoint<OfficeAuth>? = null
    @Volatile private var hireAskedAt = 0L
    private var models: Triple<String, Long, ModelCatalogue>? = null
    private val slash = ConcurrentHashMap<String, Triple<String, Long, List<DroidCommand>>>()

    /**
     * The name the office knows this phone by (`?name=`, at most 24 characters), and so `createdBy`
     * of what it hires; the 📱 tells the office's own page that a phone did it.
     */
    val officeName: String = "📱 $deviceName".take(24).trim()

    init {
        scope.launch {
            val wanted = holders.map { it.isNotEmpty() }.distinctUntilChanged().transformLatest { held ->
                if (held) emit(true) else {
                    delay(IDLE_GRACE_MS)
                    emit(false)
                }
            }.distinctUntilChanged()
            val office = store.snapshot.filter { it.loaded }.map { it.active }
                .distinctUntilChanged { a, b -> a?.id == b?.id && a?.bases == b?.bases && a?.auth == b?.auth }
            val net = network.state.map { it.available to it.networkKey }.distinctUntilChanged()
            combine(office, wanted, net, nonce) { o, w, n, r -> Desire(o, w, n.first, n.second, r) }
                .collectLatest { run(it) }
        }
    }

    fun hold(tag: String) = holders.update { it + tag }
    fun release(tag: String) = holders.update { it - tag }

    /** Drop whatever is going on and race the routes again now (pull to refresh, the retry button). */
    fun retryNow() {
        nonce.value++
    }

    val connected: Boolean get() = _link.value.phase == Phase.Connected && socket != null

    fun send(json: String): Boolean = socket?.takeIf { _link.value.phase == Phase.Connected }?.send(json) ?: false

    /** Holds the connection until it's up (or [timeoutMs] passes), sends, then lets go. */
    suspend fun sendWhenConnected(json: String, timeoutMs: Long = 12_000): Boolean {
        val tag = "send-${System.nanoTime()}"
        hold(tag)
        try {
            withTimeoutOrNull(timeoutMs) { link.first { it.phase == Phase.Connected } } ?: return false
            return send(json)
        } finally {
            release(tag)
        }
    }

    /**
     * Attaches to a worker's terminal: its stream comes in, and the office takes keys for it only
     * from an attached window. Counted, so the terminal screen and an answer from the Asks tab or a
     * notification can each hold it; it detaches when the last one lets go.
     */
    fun attach(workerId: String) {
        synchronized(holds) { holds[workerId] = (holds[workerId] ?: 0) + 1 }
        attached += workerId
        feeds.getOrPut(workerId) { TermFeed() }
        send(ClientMsg.attach(workerId))
    }

    fun detach(workerId: String) {
        val left = synchronized(holds) {
            val n = (holds[workerId] ?: 1) - 1
            if (n <= 0) holds.remove(workerId) else holds[workerId] = n
            n
        }
        if (left > 0) return
        attached -= workerId
        feeds.remove(workerId)
        send(ClientMsg.detach(workerId))
    }

    /**
     * Types [keys] into a worker's terminal as an answer, attaching for the moment it takes when
     * nothing on this phone has it open. False when the office can't be reached.
     */
    fun answer(workerId: String, keys: String): Boolean {
        attach(workerId)
        return try {
            send(ClientMsg.termInput(workerId, keys))
        } finally {
            detach(workerId)
        }
    }

    /** The stream of a terminal this phone attached to; null once it detached. */
    fun feed(workerId: String): TermFeed? = feeds[workerId]

    /** Asks the office for a fresh snapshot of an attached terminal (attaching again sends one). */
    fun resnapshot(workerId: String) {
        if (workerId in attached) send(ClientMsg.attach(workerId))
    }

    fun goFloor(floorId: String) {
        if (send(ClientMsg.floorGo(floorId))) scope.launch { _data.value.officeId?.let { id -> store.update(id) { it.copy(lastFloor = floorId) } } }
    }

    fun reorderFloor(floorId: String, before: String?): Boolean = send(ClientMsg.floorReorder(floorId, before))

    /**
     * Hires at [deskId], or at a desk the office picks (`deskId: "auto"`). An older office (one paired
     * by LAN token) can't pick, so the lowest free desk is chosen here.
     */
    fun hire(prompt: String?, kind: String, model: String?, effort: String?, worktree: Boolean, deskId: String? = null): Boolean {
        val office = store.snapshot.value.active
        val desk = deskId ?: if (office?.auth == AuthMode.Lan) Workers.freeDesk(_data.value.workers.values) else "auto"
        hireAskedAt = System.currentTimeMillis()
        return send(ClientMsg.spawn(desk, prompt, worktree, kind, model, effort))
    }

    private val _catalogue = MutableStateFlow<ModelCatalogue?>(null)

    /** The last model catalogue the office sent, for model names on cards; null until [models] has loaded one. */
    val catalogue: StateFlow<ModelCatalogue?> = _catalogue.asStateFlow()

    suspend fun models(): ModelCatalogue? {
        val (base, auth) = current ?: return null
        models?.let { (b, at, m) -> if (b == base && System.currentTimeMillis() - at < 60_000) return m }
        return api.models(base, auth)?.also {
            models = Triple(base, System.currentTimeMillis(), it)
            _catalogue.value = it
        }
    }

    /** The skills and custom commands [workerId]'s droid offers as slash commands, cached for a minute; null until the office answers. */
    suspend fun slashCommands(workerId: String): List<DroidCommand>? {
        val (base, auth) = current ?: return null
        slash[workerId]?.let { (b, at, c) -> if (b == base && System.currentTimeMillis() - at < 60_000) return c }
        return api.slashCommands(base, auth, workerId)?.also { if (it.isNotEmpty()) slash[workerId] = Triple(base, System.currentTimeMillis(), it) }
    }

    suspend fun hostUpdate(officeId: String, action: HostUpdateAction? = null, version: String? = null): Result<HostUpdateState> {
        val endpoint = current ?: return Result.failure(IllegalStateException("Not connected to the office"))
        val target = endpoint.forOffice(officeId, store.snapshot.value.active?.id)
            ?: return Result.failure(IllegalStateException("The active office changed. Open its host update view again."))
        return api.hostUpdate(target.base, target.auth, action, version)
    }

    suspend fun stageImage(name: String, type: String, bytes: ByteArray): Result<String> {
        val (base, auth) = current ?: return Result.failure(IllegalStateException("Not connected to the office"))
        val floor = _data.value.floorId ?: return Result.failure(IllegalStateException("Not on a floor yet"))
        return api.stageImage(base, auth, floor, name, type, bytes)
    }

    fun unstageImage(id: String) {
        val (base, auth) = current ?: return
        val floor = _data.value.floorId ?: return
        scope.launch { api.unstageImage(base, auth, floor, id) }
    }

    /**
     * Something on screen shows a Whiteboard: committed changes are fetched as they arrive while one
     * watches, and once when the first starts again. Main thread only, like the board itself.
     */
    fun watchBoard(tag: String) {
        boardWatchers += tag
        whiteboard.watching = true
    }

    fun unwatchBoard(tag: String) {
        boardWatchers -= tag
        whiteboard.watching = boardWatchers.isNotEmpty()
    }

    /** Applies the owner's changes to a floor's Whiteboard; answers once the office committed them, or why not. */
    suspend fun applyBoard(floorId: String, ops: List<JsonObject>): WbResult {
        val done = CompletableDeferred<WbResult>()
        whiteboard.apply(floorId, ops) { done.complete(it) }
        return done.await()
    }

    /** Fires and forgets: the board shows the change once the office commits it. */
    fun applyBoardLater(floorId: String, ops: List<JsonObject>) = whiteboard.apply(floorId, ops)

    fun refreshBoard(floorId: String) = whiteboard.refresh(floorId)

    /** Types the Whiteboard line into a worker's terminal, as its status allows; [pinged] says how it went. */
    fun pingBoard(workerId: String): Boolean = send(WbPinged.ping(workerId))

    suspend fun boardRenderStatus(floor: String, card: String): WbRenderStatus? {
        val (base, auth) = current ?: return null
        return api.boardRenderStatus(base, auth, floor, card)
    }

    suspend fun boardImage(floor: String, card: String, thumb: Boolean, tile: Int, version: Long): ByteArray? {
        val (base, auth) = current ?: return null
        return api.boardImage(base, auth, floor, card, thumb, tile, version)
    }

    /** Sends a batch; [done] runs on the main thread once the office has committed it or said why not. */
    fun applyBoard(floorId: String, ops: List<JsonObject>, done: (WbResult) -> Unit) = whiteboard.apply(floorId, ops, done)

    /** A file of a live card's page, on the route the app uses now. Blocking: the WebView asks on its own thread. */
    fun cardFile(cap: String, path: String): WbFetched? {
        val (base, _) = current ?: return null
        return api.cardFile(base, cap, path)
    }

    /** A file of the office's 3D props or fonts, for the overview page. Blocking, like [cardFile]. */
    fun officeFile(path: String): WbFetched? {
        val (base, _) = current ?: return null
        return api.publicFile(base, path)
    }

    /** A picture on a card, by hash. Blocking, like [cardFile]. */
    fun boardFile(floor: String, card: String, hash: String): WbFetched? {
        val (base, auth) = current ?: return null
        return api.boardFile(base, auth, floor, card, hash)
    }

    /** Uploads a picture for the board; the batch that puts it on a card has to follow within the hour. */
    suspend fun boardBlob(floor: String, mime: String, bytes: ByteArray): Result<WbFileRef> {
        val (base, auth) = current ?: return Result.failure(IllegalStateException("Not connected to the office"))
        return api.boardBlob(base, auth, floor, mime, bytes)
    }

    private fun newWhiteboard() = WhiteboardSync(::send).also { s ->
        s.watching = boardWatchers.isNotEmpty()
        s.onChange = { _boards.value = s.all() }
    }

    /** Unpairs from the office when it can (best effort: it may be off), then forgets it here. */
    suspend fun forget(office: PairedOffice) {
        if (office.auth == AuthMode.Device) {
            val token = store.token(office.id)
            if (token != null) {
                val bases = listOfNotNull(office.lastBase) + office.bases
                val win = racer.race(bases) { api.hello(it, OfficeAuth.Device(token)) }
                if (win is RaceResult.Winner) api.unpair(win.base, OfficeAuth.Device(token))
            }
        }
        store.remove(office.id)
    }

    private suspend fun run(d: Desire) {
        val office = d.office
        if (office == null) {
            _hiddenModels.value = emptySet()
            _subscriptions.value = null
            _availability.value = emptyMap()
            linkValue = Link()
            _data.value = OfficeData()
            _screens.value = emptyMap()
            return
        }
        if (_data.value.officeId != office.id) {
            _hiddenModels.value = emptySet()
            _subscriptions.value = null
            _availability.value = emptyMap()
            _data.value = OfficeData(officeId = office.id)
            _screens.value = emptyMap()
            attached.clear()
            synchronized(holds) { holds.clear() }
            holdGeneration++
            feeds.clear()
            models = null
            whiteboard.close()
            whiteboard = newWhiteboard()
            _boards.value = emptyMap()
        }
        if (!d.wanted) {
            linkValue = Link(Phase.Idle, office.id)
            return
        }
        if (!d.online) {
            linkValue = Link(Phase.Offline, office.id, detail = "The phone is offline. Workers keep going at the office.")
            return
        }
        val token = store.token(office.id)
        if (token == null) {
            linkValue = Link(Phase.Unauthorized, office.id, detail = "This phone lost its key for the office")
            awaitCancellation()
        }
        val auth = if (office.auth == AuthMode.Lan) OfficeAuth.Lan(token) else OfficeAuth.Device(token)
        val backoff = Backoff()
        while (currentCoroutineContext().isActive) {
            linkValue = _link.value.copy(phase = if (backoff.attempt == 0) Phase.Connecting else Phase.Reconnecting, officeId = office.id, attempt = backoff.attempt, retryAt = null)
            when (val race = racer.race(office.bases) { api.hello(it, auth) }) {
                is RaceResult.Unauthorized -> {
                    linkValue = Link(Phase.Unauthorized, office.id, base = race.base, detail = if (office.auth == AuthMode.Lan) "The office restarted, so its old QR code no longer works" else "This phone was unpaired from the office")
                    awaitCancellation()
                }
                is RaceResult.AllFailed -> {
                    val wait = backoff.next()
                    linkValue = Link(Phase.Reconnecting, office.id, attempt = backoff.attempt, retryAt = System.currentTimeMillis() + wait, detail = "Can't reach the office on ${office.bases.size} address${if (office.bases.size == 1) "" else "es"}")
                    delay(wait)
                }
                is RaceResult.Winner -> {
                    val probe: Probe.Ok = race.probe
                    // name follows the office. label is this phone's rename and is left alone.
                    store.update(office.id) {
                        it.copy(lastBase = race.base, lastSeenAt = System.currentTimeMillis(), name = probe.officeName ?: it.name, version = probe.version ?: it.version)
                    }
                    current = OfficeEndpoint(race.base, auth, office.id)
                    linkValue = Link(Phase.Connecting, office.id, base = race.base, kind = race.kind, attempt = backoff.attempt)
                    val end = session(office, race.base, race.kind, auth)
                    if (end.unpaired) {
                        // Unpaired from the office (its Settings → Phone & web, or here): no point retrying the same token.
                        linkValue = Link(Phase.Unauthorized, office.id, base = race.base, detail = "This phone was unpaired from the office")
                        _data.update { it.copy(synced = false) }
                        awaitCancellation()
                    }
                    if (end.upgrade) {
                        backoff.reset()
                        continue
                    }
                    if (end.welcomed) backoff.reset()
                    val wait = backoff.next()
                    linkValue = Link(Phase.Reconnecting, office.id, base = race.base, kind = race.kind, attempt = backoff.attempt, retryAt = System.currentTimeMillis() + wait, detail = end.reason)
                    delay(wait)
                }
            }
        }
    }

    private suspend fun session(office: PairedOffice, base: String, kind: RouteKind, auth: OfficeAuth): SessionEnd {
        val events = Channel<SocketEvent>(Channel.UNLIMITED)
        val floor = store.snapshot.value.offices.firstOrNull { it.id == office.id }?.lastFloor
        val ws = api.socket(base, auth, floor, officeName, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                events.trySend(SocketEvent.Text(text))
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                events.trySend(SocketEvent.Closed(reason.ifBlank { "The office closed the connection" }, code))
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                events.trySend(SocketEvent.Closed(reason.ifBlank { "Connection closed" }, code))
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                events.trySend(SocketEvent.Failed(t.message ?: "Connection lost", response?.code))
            }
        })
        socket = ws
        val epoch = log.opened()
        log.event()?.let(::dispatch)
        var welcomed = false
        // On Tailscale after a Wi-Fi blip, nothing about the phone's network changes when Wi-Fi to the
        // office comes back, so check the better routes now and then and move over when one answers.
        val better = Routes.better(office.bases, base)
        val upgrade = if (better.isEmpty()) null else scope.launch {
            while (isActive) {
                delay(UPGRADE_CHECK_MS)
                if (racer.race(better) { api.hello(it, auth) } is RaceResult.Winner) {
                    events.trySend(SocketEvent.Upgrade)
                    break
                }
            }
        }
        try {
            for (e in events) {
                when (e) {
                    is SocketEvent.Text -> {
                        val msg = Protocol.decode(e.text) ?: continue
                        if (msg is ServerMsg.Welcome) {
                            welcomed = true
                            liveEpoch = epoch
                        }
                        // The React Native side hears the welcome (after its connected link) before
                        // the native state changes, so a link it sees is never newer than its messages.
                        Frame.parse(e.text)?.let { f -> log.frame(epoch, f, office.id).forEach(::dispatch) }
                        if (msg is ServerMsg.Welcome) {
                            linkValue = Link(Phase.Connected, office.id, base = base, kind = kind)
                            for (id in attached) ws.send(ClientMsg.attach(id))
                        }
                        handle(office.id, msg)
                    }
                    is SocketEvent.Closed -> return SessionEnd(welcomed, e.reason, unpaired = e.code == CLOSE_UNPAIRED)
                    is SocketEvent.Failed -> return SessionEnd(welcomed, if (e.code == 401) "The office refused the connection" else e.reason, unpaired = e.code == 401 && auth is OfficeAuth.Device)
                    SocketEvent.Upgrade -> return SessionEnd(welcomed, "Moving to a better route", upgrade = true)
                }
            }
            return SessionEnd(welcomed, "Connection closed")
        } finally {
            upgrade?.cancel()
            socket = null
            if (liveEpoch == epoch) liveEpoch = null
            log.closed(epoch)?.let(::dispatch)
            ws.cancel()
            whiteboard.status(false)
        }
    }

    private fun handle(officeId: String, msg: ServerMsg) {
        when (msg) {
            is ServerMsg.Welcome -> {
                whiteboard.status(true)
                whiteboard.welcome(msg.view.floor)
                _availability.value = msg.availability
                _hiddenModels.value = msg.hiddenModels
                _subscriptions.value = msg.subscriptions
                enter(officeId, msg.view, msg.floors, msg.version)
                msg.view.project?.name?.ifBlank { null }?.let { p -> scope.launch { store.update(officeId) { it.copy(project = p) } } }
            }
            is ServerMsg.FloorEnter -> {
                whiteboard.enter(msg.view.floor)
                enter(officeId, msg.view, null, null)
                msg.view.floor?.let { f -> scope.launch { store.update(officeId) { it.copy(lastFloor = f, project = msg.view.project?.name?.ifBlank { null } ?: it.project) } } }
            }
            is ServerMsg.HiddenModels -> _hiddenModels.value = msg.ids
            is ServerMsg.Floors -> _data.update { it.copy(floors = msg.floors) }
            is ServerMsg.Subscriptions -> {
                _availability.value = msg.availability
                _subscriptions.value = msg.state
            }
            is ServerMsg.WorkerUpdate -> {
                val w = msg.worker
                val before = _data.value.workers
                if (!before.containsKey(w.id) && w.createdBy == officeName && System.currentTimeMillis() - hireAskedAt < HIRE_WINDOW_MS) {
                    hireAskedAt = 0
                    _hired.tryEmit(w)
                }
                _data.update { it.copy(workers = it.workers + (w.id to w)) }
                val was = before[w.id]
                if (was != null && (was.cols != w.cols || was.rows != w.rows)) feeds[w.id]?.push(TermEvent.Resize(TermSize(w.cols, w.rows)))
            }
            is ServerMsg.WorkerRemove -> {
                _data.update { it.copy(workers = it.workers - msg.workerId) }
                _screens.update { it - msg.workerId }
                attached -= msg.workerId
                synchronized(holds) { holds.remove(msg.workerId) }
                feeds.remove(msg.workerId)
            }
            is ServerMsg.Screen -> _screens.update { it + (msg.workerId to ScreenState.apply(it[msg.workerId], msg)) }
            is ServerMsg.TermSnapshot -> feeds[msg.workerId]?.push(msg.event)
            is ServerMsg.TermData -> feeds[msg.workerId]?.push(msg.event)
            is ServerMsg.Toast -> _toasts.tryEmit(msg)
            is ServerMsg.Pulls -> _data.update { it.copy(pulls = msg.state.items) }
            is ServerMsg.Worktree -> _worktrees.tryEmit(msg)
            is ServerMsg.Whiteboard -> whiteboard.handle(msg.t, msg.obj)
            is ServerMsg.Pinged -> _pinged.tryEmit(msg.result)
            is ServerMsg.ThreadSnapshot -> _threads.tryEmit(msg)
            is ServerMsg.Pong, is ServerMsg.Ignored -> Unit
        }
    }

    private fun enter(officeId: String, view: FloorView, floors: List<FloorInfo>?, version: String?) {
        _screens.value = emptyMap()
        _data.update {
            it.copy(
                officeId = officeId,
                floors = floors ?: it.floors,
                floorId = view.floor,
                project = view.project,
                workers = view.workers.associateBy(WorkerInfo::id),
                pulls = view.pulls.items,
                version = version ?: it.version,
                synced = true,
            )
        }
    }

    private companion object {
        /** How long the connection stays up after the last holder lets go (a quick app switch keeps it). */
        const val IDLE_GRACE_MS = 20_000L
        const val HIRE_WINDOW_MS = 30_000L
        const val UPGRADE_CHECK_MS = 30_000L
        /** The close code an office sends a phone's sockets when that phone is unpaired. */
        const val CLOSE_UNPAIRED = 4401
    }
}
