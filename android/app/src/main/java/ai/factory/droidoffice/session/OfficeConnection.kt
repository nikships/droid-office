package ai.factory.droidoffice.session

import ai.factory.droidoffice.core.Backoff
import ai.factory.droidoffice.core.OfficeEndpoint
import ai.factory.droidoffice.core.HostUpdateAction
import ai.factory.droidoffice.core.HostUpdateState
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.DroidCommand
import ai.factory.droidoffice.core.FloorInfo
import ai.factory.droidoffice.core.FloorView
import ai.factory.droidoffice.core.GhPull
import ai.factory.droidoffice.core.MissionAgent
import ai.factory.droidoffice.core.MissionControl
import ai.factory.droidoffice.core.MissionControlState
import ai.factory.droidoffice.core.ModelAvailability
import ai.factory.droidoffice.core.ORCHESTRATOR_ID
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
import ai.factory.droidoffice.core.WorkerStatus
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
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
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

/** The floor the phone is on, and the building's cross-floor roster, as the office last described them. */
data class OfficeData(
    val officeId: String? = null,
    val floors: List<FloorInfo> = emptyList(),
    val floorId: String? = null,
    val project: ProjectInfo? = null,
    val workers: Map<String, WorkerInfo> = emptyMap(),
    val pulls: List<GhPull> = emptyList(),
    val buildingWorkers: Map<String, Map<String, WorkerInfo>> = emptyMap(),
    val buildingPulls: Map<String, List<GhPull>> = emptyMap(),
    val hasBuildingRoster: Boolean = false,
    val version: String? = null,
    /** A welcome has arrived since this office became the active one. */
    val synced: Boolean = false,
    /** Only a welcome that explicitly advertises the checkbox-answer contract enables it. */
    val workerAnswerMultiSelect: Boolean = false,
    /** The building's agents, the same on every floor; null from an office that predates Mission Control. */
    val mission: MissionControlState? = null,
) {
    val floor: FloorInfo? get() = floors.firstOrNull { it.id == floorId }

    /** Desk and cloud workers on each floor, falling back to the active floor when connected to an older office. */
    val workersByFloor: Map<String, Collection<WorkerInfo>>
        get() = if (hasBuildingRoster || buildingWorkers.isNotEmpty()) {
            buildMap {
                buildingWorkers.forEach { (f, map) -> put(f, map.values) }
                floorId?.let { put(it, workers.values) }
            }
        } else {
            floorId?.let { mapOf(it to workers.values) }.orEmpty()
        }

    /** Pull requests on each floor, falling back to the active floor when connected to an older office. */
    val pullsByFloor: Map<String, List<GhPull>>
        get() = buildMap {
            buildingPulls.forEach { (f, list) -> put(f, list) }
            floorId?.let { put(it, pulls) }
        }

    /** The floor id of a desk/cloud worker anywhere in the building, or null for building agents / unknown workers. */
    fun workerFloorId(id: String): String? {
        if (id == ORCHESTRATOR_ID || mission?.bots?.any { it.worker.id == id } == true) return null
        if (workers.containsKey(id)) return floorId
        buildingWorkers.entries.firstOrNull { (_, map) -> map.containsKey(id) }?.key?.let { return it }
        MissionControl.team(mission?.orchestrator).firstOrNull { it.id == id }?.floor?.takeIf { it.isNotBlank() }?.let { return it }
        return mission?.bots?.asSequence()?.flatMap { it.team.asSequence() }?.firstOrNull { it.id == id }?.floor?.takeIf { it.isNotBlank() }
    }

    fun floorOfWorker(id: String): FloorInfo? {
        val fId = workerFloorId(id) ?: return null
        return floors.firstOrNull { it.id == fId }
    }

    /** A desk or cloud worker on the active floor or any other floor in the building. */
    fun deskWorker(id: String): WorkerInfo? = workers[id] ?: buildingWorkers.values.firstNotNullOfOrNull { it[id] }

    /** A worker anywhere in the building, or a building agent in Mission Control (the Orchestrator while it is on, or a bot). */
    fun worker(id: String): WorkerInfo? = deskWorker(id) ?: MissionControl.agent(mission, id)?.worker

    /** Pull requests for [id]'s floor, so cross-floor cards and screens resolve the right PR badge. */
    fun pullsForWorker(id: String): List<GhPull> {
        val fId = workerFloorId(id)
        return if (fId == null || fId == floorId) pulls else buildingPulls[fId].orEmpty()
    }

    /** Every desk and cloud worker across the building, ordered by floor. */
    val allDeskWorkers: List<WorkerInfo>
        get() {
            if (!hasBuildingRoster && buildingWorkers.isEmpty()) return workers.values.toList()
            val byFloor = workersByFloor
            val seen = HashSet<String>()
            val out = ArrayList<WorkerInfo>()
            val orderedFloors = floors.map { it.id } + byFloor.keys.filter { k -> floors.none { it.id == k } }.sorted()
            for (f in orderedFloors) {
                for (w in byFloor[f].orEmpty()) {
                    if (MissionControl.isDeskWorker(w, mission) && seen.add(w.id)) out += w
                }
            }
            return out
        }

    /** The Orchestrator's session while it is on and has one. */
    val orchestrator: WorkerInfo? get() = MissionControl.orchestrator(mission)

    /** Everyone whose questions and finished turns are the owner's: every floor's workers and the Orchestrator. */
    val askable: Collection<WorkerInfo> get() = orchestrator?.let { allDeskWorkers + it } ?: allDeskWorkers

    /** How many workers across the whole building are waiting on an answer right now. */
    val totalWaitingCount: Int
        get() {
            val known = askable.count { !it.remote && it.state == WorkerStatus.NeedsInput }
            if (hasBuildingRoster || buildingWorkers.isNotEmpty()) return known
            return known + floors.filter { it.id != floorId }.sumOf { it.waiting }
        }
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

    private val _data = MutableStateFlow(OfficeData())
    val data: StateFlow<OfficeData> = _data.asStateFlow()

    private val _availability = MutableStateFlow<Map<String, ModelAvailability>>(emptyMap())

    private val _hiddenModels = MutableStateFlow<Set<String>>(emptySet())
    val hiddenModels = _hiddenModels.asStateFlow()
    private val _subscriptions = MutableStateFlow<ai.factory.droidoffice.core.SubscriptionState?>(null)
    val subscriptions = _subscriptions.asStateFlow()
    private val _factory = MutableStateFlow<ai.factory.droidoffice.core.FactoryState?>(null)

    /** The office's Factory connection, computers and Environments; null from an office that doesn't send it. */
    val factory = _factory.asStateFlow()
    private val _catalogue = MutableStateFlow<ModelCatalogue?>(null)

    /** Subscription and Factory gates share one live map for every existing model-picker caller. */
    val availability: StateFlow<Map<String, ModelAvailability>> = combine(_availability, _factory, _catalogue) { proxy, factory, catalogue ->
        proxy + catalogue?.models.orEmpty().mapNotNull { model ->
            ai.factory.droidoffice.core.FactoryLimits.availability(factory, model.id, model.custom)?.let { model.id to it }
        }
    }.stateIn(scope, SharingStarted.Eagerly, emptyMap())

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
    /** Each attached terminal's stream, on the main thread like [handle]. */
    private val feeds = HashMap<String, TermFeed>()
    @Volatile private var socket: WebSocket? = null
    @Volatile private var current: OfficeEndpoint<OfficeAuth>? = null
    @Volatile private var hireAskedAt = 0L
    private var models: Triple<String, Long, ModelCatalogue>? = null
    private val slash = ConcurrentHashMap<String, Triple<String, Long, List<DroidCommand>>>()
    private val actionRequests = ConcurrentHashMap<String, CompletableDeferred<ServerMsg.ActionResult?>>()
    /** Changes when a socket ends, so a delayed answer cannot cross a reconnection. */
    var answerEpoch: Long = 0
        private set

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

    /** A successful socket write is not an answer receipt. Never queue or replay an answer. */
    suspend fun answerConfirmed(requestId: String, json: String): ServerMsg.ActionResult? = actionConfirmed(requestId, json)

    /** Await the office's receipt, without queuing or replaying an unconfirmed action. */
    suspend fun actionConfirmed(requestId: String, json: String): ServerMsg.ActionResult? {
        val receipt = CompletableDeferred<ServerMsg.ActionResult?>()
        actionRequests[requestId] = receipt
        return try {
            if (!send(json)) return null
            withTimeoutOrNull(60_000) { receipt.await() }
        } finally {
            actionRequests.remove(requestId)
        }
    }

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

    /** The stream of a terminal this phone attached to; null once it detached. */
    fun feed(workerId: String): TermFeed? = feeds[workerId]

    /** Asks the office for a fresh snapshot of an attached terminal (attaching again sends one). */
    fun resnapshot(workerId: String) {
        if (workerId in attached) send(ClientMsg.attach(workerId))
    }

    /** Asks the office to move this phone to [floorId]; false when the message couldn't be sent. */
    fun goFloor(floorId: String): Boolean {
        val sent = send(ClientMsg.floorGo(floorId))
        if (sent) scope.launch { _data.value.officeId?.let { id -> store.update(id) { it.copy(lastFloor = floorId) } } }
        return sent
    }

    fun reorderFloor(floorId: String, before: String?): Boolean = send(ClientMsg.floorReorder(floorId, before))

    /**
     * Hires at [deskId], or at a desk the office picks (`deskId: "auto"`). An older office (one paired
     * by LAN token) can't pick, so the lowest free desk is chosen here. With [cloud], it works on a Factory computer.
     */
    fun hire(prompt: String?, kind: String, model: String?, effort: String?, worktree: Boolean, deskId: String? = null, cloud: ai.factory.droidoffice.core.CloudHire? = null, repos: List<String> = emptyList()): Boolean {
        val office = store.snapshot.value.active
        val desk = deskId ?: if (office?.auth == AuthMode.Lan) Workers.freeDesk(_data.value.workers.values) else "auto"
        hireAskedAt = System.currentTimeMillis()
        return send(ClientMsg.spawn(desk, prompt, worktree, kind, model, effort, cloud, repos))
    }

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

    suspend fun factoryOverage(officeId: String, preference: String): Result<Unit> {
        val endpoint = current ?: return Result.failure(IllegalStateException("Not connected to the office"))
        val target = endpoint.forOffice(officeId, store.snapshot.value.active?.id)
            ?: return Result.failure(IllegalStateException("The active office changed. Open Subscriptions again."))
        return api.factoryOverage(target.base, target.auth, preference)
    }

    /** Stages a picture for a prompt to [workerId]: the Orchestrator keeps its own, whatever floor the phone is on. */
    suspend fun stageImage(name: String, type: String, bytes: ByteArray, workerId: String? = null): Result<String> {
        val (base, auth) = current ?: return Result.failure(IllegalStateException("Not connected to the office"))
        if (workerId == ORCHESTRATOR_ID) return api.stageImage(base, auth, null, name, type, bytes, worker = ORCHESTRATOR_ID)
        val snap = _data.value
        val floor = (if (workerId != null) snap.workerFloorId(workerId) ?: snap.floorId.takeIf { !snap.hasBuildingRoster } else snap.floorId)
            ?: return Result.failure(IllegalStateException("Not on a floor yet"))
        return api.stageImage(base, auth, floor, name, type, bytes)
    }

    fun unstageImage(id: String, workerId: String? = null) {
        val (base, auth) = current ?: return
        if (workerId == ORCHESTRATOR_ID) {
            scope.launch { api.unstageImage(base, auth, null, id, worker = ORCHESTRATOR_ID) }
            return
        }
        val snap = _data.value
        val floor = (if (workerId != null) snap.workerFloorId(workerId) ?: snap.floorId.takeIf { !snap.hasBuildingRoster } else snap.floorId) ?: return
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

    suspend fun threadImage(floor: String, worker: String, image: String): ByteArray? {
        val (base, auth) = current ?: return null
        return api.threadImage(base, auth, floor, worker, image)
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
            _factory.value = null
            _availability.value = emptyMap()
            _link.value = Link()
            _data.value = OfficeData()
            _screens.value = emptyMap()
            return
        }
        if (_data.value.officeId != office.id) {
            _hiddenModels.value = emptySet()
            _subscriptions.value = null
            _factory.value = null
            _availability.value = emptyMap()
            _data.value = OfficeData(officeId = office.id)
            _screens.value = emptyMap()
            attached.clear()
            synchronized(holds) { holds.clear() }
            feeds.clear()
            models = null
            whiteboard.close()
            whiteboard = newWhiteboard()
            _boards.value = emptyMap()
        }
        if (!d.wanted) {
            _link.value = Link(Phase.Idle, office.id)
            return
        }
        if (!d.online) {
            _link.value = Link(Phase.Offline, office.id, detail = "The phone is offline. Workers keep going at the office.")
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
                    // name follows the office. label is this phone's rename and is left alone.
                    store.update(office.id) {
                        it.copy(lastBase = race.base, lastSeenAt = System.currentTimeMillis(), name = probe.officeName ?: it.name, version = probe.version ?: it.version)
                    }
                    current = OfficeEndpoint(race.base, auth, office.id)
                    _link.value = Link(Phase.Connecting, office.id, base = race.base, kind = race.kind, attempt = backoff.attempt)
                    val end = session(office, race.base, race.kind, auth)
                    if (end.unpaired) {
                        // Unpaired from the office (its Settings → Phone & web, or here): no point retrying the same token.
                        _link.value = Link(Phase.Unauthorized, office.id, base = race.base, detail = "This phone was unpaired from the office")
                        _data.update { it.copy(synced = false) }
                        awaitCancellation()
                    }
                    if (end.upgrade) {
                        backoff.reset()
                        continue
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
                            _link.value = Link(Phase.Connected, office.id, base = base, kind = kind)
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
            answerEpoch++
            actionRequests.values.forEach { it.complete(null) }
            actionRequests.clear()
            ws.cancel()
            whiteboard.status(false)
        }
    }

    private fun handle(officeId: String, msg: ServerMsg) {
        when (msg) {
            is ServerMsg.Welcome -> {
                val missionState = msg.missionControl
                val bWorkers = msg.building?.associate { r ->
                    r.floor to r.workers.filter { w -> MissionControl.isDeskWorker(w, missionState) }.associateBy(WorkerInfo::id)
                }?.toMutableMap()
                val bPulls = msg.building?.associate { r -> r.floor to r.pulls }?.toMutableMap()
                if (bWorkers != null && msg.view.floor != null) {
                    bWorkers[msg.view.floor] = msg.view.workers.filter { w -> MissionControl.isDeskWorker(w, missionState) }.associateBy(WorkerInfo::id)
                }
                if (bPulls != null && msg.view.floor != null) {
                    bPulls[msg.view.floor] = msg.view.pulls.items
                }
                _data.update {
                    it.copy(
                        workerAnswerMultiSelect = msg.workerAnswerMultiSelect,
                        buildingWorkers = bWorkers ?: emptyMap(),
                        buildingPulls = bPulls ?: emptyMap(),
                        hasBuildingRoster = msg.building != null,
                    )
                }
                // An office that predates Mission Control sends none; one that sends it goes through the same path as a broadcast.
                if (missionState != null) mission(missionState) else _data.update { it.copy(mission = null) }
                whiteboard.status(true)
                whiteboard.welcome(msg.view.floor)
                _availability.value = msg.availability
                _hiddenModels.value = msg.hiddenModels
                _subscriptions.value = msg.subscriptions
                _factory.value = msg.factory
                enter(officeId, msg.view, msg.floors, msg.version, keepOffFloorScreens = false)
                msg.view.project?.name?.ifBlank { null }?.let { p -> scope.launch { store.update(officeId) { it.copy(project = p) } } }
            }
            is ServerMsg.FloorEnter -> {
                whiteboard.enter(msg.view.floor)
                enter(officeId, msg.view, null, null, keepOffFloorScreens = true)
                msg.view.floor?.let { f -> scope.launch { store.update(officeId) { it.copy(lastFloor = f, project = msg.view.project?.name?.ifBlank { null } ?: it.project) } } }
            }
            is ServerMsg.HiddenModels -> _hiddenModels.value = msg.ids
            is ServerMsg.Factory -> _factory.value = msg.state
            is ServerMsg.Floors -> _data.update {
                val valid = msg.floors.map(FloorInfo::id).toSet()
                it.copy(
                    floors = msg.floors,
                    buildingWorkers = it.buildingWorkers.filterKeys(valid::contains),
                    buildingPulls = it.buildingPulls.filterKeys(valid::contains),
                )
            }
            is ServerMsg.Subscriptions -> {
                _availability.value = msg.availability
                _subscriptions.value = msg.state
            }
            is ServerMsg.MissionControl -> mission(msg.state)
            is ServerMsg.BuildingWorker -> {
                val w = msg.worker
                if (w.id == ORCHESTRATOR_ID || !MissionControl.isDeskWorker(w, _data.value.mission)) return
                val knownBefore = _data.value.deskWorker(w.id)
                if (knownBefore == null && w.createdBy == officeName && System.currentTimeMillis() - hireAskedAt < HIRE_WINDOW_MS) {
                    hireAskedAt = 0
                    _hired.tryEmit(w)
                }
                val activeFloor = _data.value.floorId
                _data.update { d ->
                    val floorMap = d.buildingWorkers[msg.floor].orEmpty() + (w.id to w)
                    d.copy(
                        buildingWorkers = d.buildingWorkers + (msg.floor to floorMap),
                        workers = if (msg.floor == d.floorId) d.workers + (w.id to w) else d.workers,
                        hasBuildingRoster = true,
                    )
                }
                if (msg.floor != activeFloor && knownBefore != null && (knownBefore.cols != w.cols || knownBefore.rows != w.rows)) {
                    feeds[w.id]?.push(TermEvent.Resize(TermSize(w.cols, w.rows)))
                }
                if (msg.floor != activeFloor && w.state != WorkerStatus.NeedsInput && w.id !in attached) {
                    _screens.update { it - w.id }
                }
            }
            is ServerMsg.BuildingRemove -> {
                _data.update { d ->
                    val nextFloorMap = d.buildingWorkers[msg.floor]?.minus(msg.workerId)
                    val nextBuilding = if (nextFloorMap == null) d.buildingWorkers else d.buildingWorkers + (msg.floor to nextFloorMap)
                    d.copy(
                        buildingWorkers = nextBuilding,
                        workers = if (msg.floor == d.floorId) d.workers - msg.workerId else d.workers,
                    )
                }
                _screens.update { it - msg.workerId }
                attached -= msg.workerId
                synchronized(holds) { holds.remove(msg.workerId) }
                feeds.remove(msg.workerId)
            }
            is ServerMsg.BuildingPulls -> {
                _data.update { d ->
                    d.copy(
                        buildingPulls = d.buildingPulls + (msg.floor to msg.pulls),
                        pulls = if (msg.floor == d.floorId) msg.pulls else d.pulls,
                    )
                }
            }
            is ServerMsg.WorkerUpdate -> {
                val w = msg.worker
                if (w.id == ORCHESTRATOR_ID) {
                    // Its own update between Mission Control states: keep its team, take its new status.
                    _data.value.mission?.let { m ->
                        val o = m.orchestrator
                        mission(m.copy(orchestrator = o.copy(agent = o.agent?.copy(worker = w) ?: MissionAgent(w))))
                    }
                    return
                }
                if (!MissionControl.isDeskWorker(w, _data.value.mission)) return
                val before = _data.value.workers
                if (_data.value.deskWorker(w.id) == null && w.createdBy == officeName && System.currentTimeMillis() - hireAskedAt < HIRE_WINDOW_MS) {
                    hireAskedAt = 0
                    _hired.tryEmit(w)
                }
                _data.update { d ->
                    val nextBuilding = if (d.hasBuildingRoster && d.floorId != null) {
                        d.buildingWorkers + (d.floorId to (d.buildingWorkers[d.floorId].orEmpty() + (w.id to w)))
                    } else d.buildingWorkers
                    d.copy(workers = d.workers + (w.id to w), buildingWorkers = nextBuilding)
                }
                val was = before[w.id]
                if (was != null && (was.cols != w.cols || was.rows != w.rows)) feeds[w.id]?.push(TermEvent.Resize(TermSize(w.cols, w.rows)))
            }
            is ServerMsg.WorkerRemove -> {
                _data.update { d ->
                    val nextBuilding = if (d.floorId != null && d.buildingWorkers.containsKey(d.floorId)) {
                        d.buildingWorkers + (d.floorId to (d.buildingWorkers[d.floorId].orEmpty() - msg.workerId))
                    } else d.buildingWorkers
                    d.copy(workers = d.workers - msg.workerId, buildingWorkers = nextBuilding)
                }
                _screens.update { it - msg.workerId }
                attached -= msg.workerId
                synchronized(holds) { holds.remove(msg.workerId) }
                feeds.remove(msg.workerId)
            }
            is ServerMsg.Screen -> _screens.update { it + (msg.workerId to ScreenState.apply(it[msg.workerId], msg)) }
            is ServerMsg.TermSnapshot -> feeds[msg.workerId]?.push(msg.event)
            is ServerMsg.TermData -> feeds[msg.workerId]?.push(msg.event)
            is ServerMsg.Toast -> _toasts.tryEmit(msg)
            is ServerMsg.Pulls -> _data.update { d ->
                val nextPulls = if (d.hasBuildingRoster && d.floorId != null) d.buildingPulls + (d.floorId to msg.state.items) else d.buildingPulls
                d.copy(pulls = msg.state.items, buildingPulls = nextPulls)
            }
            is ServerMsg.Worktree -> _worktrees.tryEmit(msg)
            is ServerMsg.Whiteboard -> whiteboard.handle(msg.t, msg.obj)
            is ServerMsg.Pinged -> _pinged.tryEmit(msg.result)
            is ServerMsg.ThreadSnapshot -> _threads.tryEmit(msg)
            is ServerMsg.ActionResult -> actionRequests.remove(msg.requestId)?.complete(msg)
            is ServerMsg.Pong, is ServerMsg.Ignored -> Unit
        }
    }

    private fun mission(state: MissionControlState) {
        val was = _data.value.orchestrator
        _data.update { d ->
            val filteredBuilding = d.buildingWorkers.mapValues { (_, map) -> map.filterValues { w -> MissionControl.isDeskWorker(w, state) } }
            d.copy(mission = state, workers = d.workers.filterValues { w -> MissionControl.isDeskWorker(w, state) }, buildingWorkers = filteredBuilding)
        }
        val now = MissionControl.orchestrator(state)
        when (MissionControl.sessionChange(was, now)) {
            MissionControl.Session.Ended -> {
                _screens.update { it - ORCHESTRATOR_ID }
                // A screen still holding its terminal gets a feed with none of the old session in it.
                if (feeds.containsKey(ORCHESTRATOR_ID)) feeds[ORCHESTRATOR_ID] = TermFeed()
            }
            MissionControl.Session.Resized -> now?.let { feeds[it.id]?.push(TermEvent.Resize(TermSize(it.cols, it.rows))) }
            MissionControl.Session.Same -> Unit
        }
    }

    /** [keepOffFloorScreens]: the Orchestrator's screen and off-floor NeedsInput menus belong to the building, so a change of floor leaves them be. */
    private fun enter(officeId: String, view: FloorView, floors: List<FloorInfo>?, version: String?, keepOffFloorScreens: Boolean) {
        val currentData = _data.value
        val activeIds = view.workers.mapTo(HashSet(), WorkerInfo::id)
        _screens.update { screens ->
            if (!keepOffFloorScreens) emptyMap()
            else screens.filterKeys { id ->
                id == ORCHESTRATOR_ID || (id !in activeIds && currentData.deskWorker(id)?.state == WorkerStatus.NeedsInput)
            }
        }
        val mission = currentData.mission
        val floorWorkers = view.workers.filter { w -> MissionControl.isDeskWorker(w, mission) }.associateBy(WorkerInfo::id)
        _data.update { d ->
            val nextBuildingWorkers = if (d.hasBuildingRoster && view.floor != null) d.buildingWorkers + (view.floor to floorWorkers) else d.buildingWorkers
            val nextBuildingPulls = if (d.hasBuildingRoster && view.floor != null) d.buildingPulls + (view.floor to view.pulls.items) else d.buildingPulls
            d.copy(
                officeId = officeId,
                floors = floors ?: d.floors,
                floorId = view.floor,
                project = view.project,
                workers = floorWorkers,
                pulls = view.pulls.items,
                buildingWorkers = nextBuildingWorkers,
                buildingPulls = nextBuildingPulls,
                version = version ?: d.version,
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
