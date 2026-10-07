package ai.factory.droidoffice.session

import ai.factory.droidoffice.core.Backoff
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.FloorInfo
import ai.factory.droidoffice.core.FloorView
import ai.factory.droidoffice.core.GhPull
import ai.factory.droidoffice.core.Probe
import ai.factory.droidoffice.core.ProjectInfo
import ai.factory.droidoffice.core.Protocol
import ai.factory.droidoffice.core.QueueState
import ai.factory.droidoffice.core.RaceResult
import ai.factory.droidoffice.core.RouteKind
import ai.factory.droidoffice.core.RouteRacer
import ai.factory.droidoffice.core.ScreenState
import ai.factory.droidoffice.core.ServerMsg
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
    val queue: QueueState = QueueState(),
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
}

private data class SessionEnd(val welcomed: Boolean, val reason: String, val unpaired: Boolean = false)

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

    private val _data = MutableStateFlow(OfficeData())
    val data: StateFlow<OfficeData> = _data.asStateFlow()

    private val _screens = MutableStateFlow<Map<String, ScreenState>>(emptyMap())
    val screens: StateFlow<Map<String, ScreenState>> = _screens.asStateFlow()

    private val _toasts = MutableSharedFlow<ServerMsg.Toast>(extraBufferCapacity = 32)
    val toasts: SharedFlow<ServerMsg.Toast> = _toasts.asSharedFlow()

    private val _worktrees = MutableSharedFlow<ServerMsg.Worktree>(extraBufferCapacity = 8)
    val worktrees: SharedFlow<ServerMsg.Worktree> = _worktrees.asSharedFlow()

    /** A worker this phone just hired arrived at its desk. */
    private val _hired = MutableSharedFlow<WorkerInfo>(extraBufferCapacity = 4)
    val hired: SharedFlow<WorkerInfo> = _hired.asSharedFlow()

    private val holders = MutableStateFlow<Set<String>>(emptySet())
    private val nonce = MutableStateFlow(0)
    private val attached = ConcurrentHashMap.newKeySet<String>()
    @Volatile private var socket: WebSocket? = null
    @Volatile private var current: Pair<String, OfficeAuth>? = null
    @Volatile private var hireAskedAt = 0L
    private var models: Triple<String, Long, ModelCatalogue>? = null

    /** The name the office knows this phone by (`?name=`, at most 24 characters), and so `createdBy` of what it hires. */
    val officeName: String = deviceName.take(24).trim()

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

    fun attach(workerId: String) {
        attached += workerId
        send(ClientMsg.attach(workerId))
    }

    fun detach(workerId: String) {
        attached -= workerId
        send(ClientMsg.detach(workerId))
    }

    fun goFloor(floorId: String) {
        if (send(ClientMsg.floorGo(floorId))) scope.launch { _data.value.officeId?.let { id -> store.update(id) { it.copy(lastFloor = floorId) } } }
    }

    /**
     * Hires at a desk the office picks (`deskId: "auto"`). An older office (one paired by LAN token)
     * can't pick, so the lowest free desk is chosen here.
     */
    fun hire(prompt: String?, kind: String, model: String?, effort: String?, worktree: Boolean): Boolean {
        val office = store.snapshot.value.active
        val desk = if (office?.auth == AuthMode.Lan) Workers.freeDesk(_data.value.workers.values) else "auto"
        hireAskedAt = System.currentTimeMillis()
        return send(ClientMsg.spawn(desk, prompt, worktree, kind, model, effort))
    }

    suspend fun models(): ModelCatalogue? {
        val (base, auth) = current ?: return null
        models?.let { (b, at, m) -> if (b == base && System.currentTimeMillis() - at < 60_000) return m }
        return api.models(base, auth)?.also { models = Triple(base, System.currentTimeMillis(), it) }
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
            _link.value = Link()
            _data.value = OfficeData()
            _screens.value = emptyMap()
            return
        }
        if (_data.value.officeId != office.id) {
            _data.value = OfficeData(officeId = office.id)
            _screens.value = emptyMap()
            attached.clear()
            models = null
        }
        if (!d.wanted) {
            _link.value = Link(Phase.Idle, office.id)
            return
        }
        if (!d.online) {
            _link.value = Link(Phase.Offline, office.id, detail = "No network")
            return
        }
        val token = store.token(office.id)
        if (token == null) {
            _link.value = Link(Phase.Unauthorized, office.id, detail = "This phone lost its key for the office")
            awaitCancellation()
        }
        val auth = if (office.auth == AuthMode.Lan) OfficeAuth.Lan(token) else OfficeAuth.Device(token)
        val backoff = Backoff()
        while (currentCoroutineContext().isActive) {
            _link.value = _link.value.copy(phase = if (backoff.attempt == 0) Phase.Connecting else Phase.Reconnecting, officeId = office.id, attempt = backoff.attempt, retryAt = null)
            when (val race = racer.race(office.bases) { api.hello(it, auth) }) {
                is RaceResult.Unauthorized -> {
                    _link.value = Link(Phase.Unauthorized, office.id, base = race.base, detail = if (office.auth == AuthMode.Lan) "The office restarted, so its old QR code no longer works" else "This phone was unpaired from the office")
                    awaitCancellation()
                }
                is RaceResult.AllFailed -> {
                    val wait = backoff.next()
                    _link.value = Link(Phase.Reconnecting, office.id, attempt = backoff.attempt, retryAt = System.currentTimeMillis() + wait, detail = "Can't reach the office on ${office.bases.size} address${if (office.bases.size == 1) "" else "es"}")
                    delay(wait)
                }
                is RaceResult.Winner -> {
                    val probe: Probe.Ok = race.probe
                    store.update(office.id) {
                        it.copy(lastBase = race.base, lastSeenAt = System.currentTimeMillis(), name = probe.officeName ?: it.name, version = probe.version ?: it.version)
                    }
                    current = race.base to auth
                    _link.value = Link(Phase.Connecting, office.id, base = race.base, kind = race.kind, attempt = backoff.attempt)
                    val end = session(office, race.base, race.kind, auth)
                    if (end.unpaired) {
                        // Unpaired from the office (its Settings → Phone, or here): no point retrying the same token.
                        _link.value = Link(Phase.Unauthorized, office.id, base = race.base, detail = "This phone was unpaired from the office")
                        _data.update { it.copy(synced = false) }
                        awaitCancellation()
                    }
                    if (end.welcomed) backoff.reset()
                    val wait = backoff.next()
                    _link.value = Link(Phase.Reconnecting, office.id, base = race.base, kind = race.kind, attempt = backoff.attempt, retryAt = System.currentTimeMillis() + wait, detail = end.reason)
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
        var welcomed = false
        try {
            for (e in events) {
                when (e) {
                    is SocketEvent.Text -> {
                        val msg = Protocol.decode(e.text) ?: continue
                        if (msg is ServerMsg.Welcome) {
                            welcomed = true
                            _link.value = Link(Phase.Connected, office.id, base = base, kind = kind)
                            for (id in attached) ws.send(ClientMsg.attach(id))
                        }
                        handle(office.id, msg)
                    }
                    is SocketEvent.Closed -> return SessionEnd(welcomed, e.reason, unpaired = e.code == CLOSE_UNPAIRED)
                    is SocketEvent.Failed -> return SessionEnd(welcomed, if (e.code == 401) "The office refused the connection" else e.reason, unpaired = e.code == 401 && auth is OfficeAuth.Device)
                }
            }
            return SessionEnd(welcomed, "Connection closed")
        } finally {
            socket = null
            ws.cancel()
        }
    }

    private fun handle(officeId: String, msg: ServerMsg) {
        when (msg) {
            is ServerMsg.Welcome -> {
                enter(officeId, msg.view, msg.floors, msg.version)
            }
            is ServerMsg.FloorEnter -> {
                enter(officeId, msg.view, null, null)
                msg.view.floor?.let { f -> scope.launch { store.update(officeId) { it.copy(lastFloor = f) } } }
            }
            is ServerMsg.Floors -> _data.update { it.copy(floors = msg.floors) }
            is ServerMsg.WorkerUpdate -> {
                val w = msg.worker
                val before = _data.value.workers
                if (!before.containsKey(w.id) && w.createdBy == officeName && System.currentTimeMillis() - hireAskedAt < HIRE_WINDOW_MS) {
                    hireAskedAt = 0
                    _hired.tryEmit(w)
                }
                _data.update { it.copy(workers = it.workers + (w.id to w)) }
            }
            is ServerMsg.WorkerRemove -> {
                _data.update { it.copy(workers = it.workers - msg.workerId) }
                _screens.update { it - msg.workerId }
                attached -= msg.workerId
            }
            is ServerMsg.Screen -> _screens.update { it + (msg.workerId to ScreenState.apply(it[msg.workerId], msg)) }
            is ServerMsg.Toast -> _toasts.tryEmit(msg)
            is ServerMsg.Queue -> _data.update { it.copy(queue = msg.state) }
            is ServerMsg.Pulls -> _data.update { it.copy(pulls = msg.state.items) }
            is ServerMsg.Worktree -> _worktrees.tryEmit(msg)
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
                queue = view.queue,
                version = version ?: it.version,
                synced = true,
            )
        }
    }

    private companion object {
        /** How long the connection stays up after the last holder lets go (a quick app switch keeps it). */
        const val IDLE_GRACE_MS = 20_000L
        const val HIRE_WINDOW_MS = 30_000L
        /** The close code an office sends a phone's sockets when that phone is unpaired. */
        const val CLOSE_UNPAIRED = 4401
    }
}
