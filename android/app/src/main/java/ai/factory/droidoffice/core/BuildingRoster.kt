package ai.factory.droidoffice.core

/** Filter keys and pure arrangement/search logic for the cross-floor Workers tab. */
enum class RosterStatusFilter(val key: String, val label: String) {
    All("all", "All"),
    NeedsInput("needs_input", "Needs you"),
    Working("working", "Working"),
    Done("done", "Done"),
    Ready("ready", "Ready"),
    Asleep("asleep", "Asleep");

    companion object {
        fun of(key: String?): RosterStatusFilter = entries.firstOrNull { it.key == key } ?: All
    }
}

enum class RosterKind { Desk, Orchestrator, Bot }

data class BuildingWorkerRow(
    val worker: WorkerInfo,
    val kind: RosterKind = RosterKind.Desk,
    val floorId: String? = null,
    val floor: FloorInfo? = null,
    val pulls: List<GhPull> = emptyList(),
    val depth: Int = 0,
    val subagents: Int = 0,
    val leadName: String? = null,
    val crossFloorLead: Boolean = false,
    val blocked: String? = null,
    val teamCount: Int = 0,
    val botLastUsedAt: Long? = null,
)

data class RosterSummary(
    val total: Int = 0,
    val waiting: Int = 0,
    val working: Int = 0,
    val done: Int = 0,
    val unackedDone: Int = 0,
    val ready: Int = 0,
    val asleep: Int = 0,
)

data class BuildingRosterView(
    /** Building-wide totals before search/chip filtering, for the header summary and badge. */
    val totalSummary: RosterSummary,
    /** Counts for each status chip under the current floor + search filter. */
    val statusCounts: Map<RosterStatusFilter, Int>,
    /** Counts for each floor chip (and [MISSION_FLOOR]) under the current status + search filter. */
    val floorCounts: Map<String, Int>,
    /** Waiting counts per floor (and [MISSION_FLOOR]), unfiltered, so floor chips still flag urgent asks. */
    val floorWaiting: Map<String, Int>,
    /** Waiting asks to pin at the top of the Workers tab under the active filters. */
    val asks: List<PendingAsk>,
    /** Arranged worker rows across the selected scope. */
    val rows: List<BuildingWorkerRow>,
)

object BuildingRoster {
    const val ALL_FLOORS = "__all__"
    const val MISSION_FLOOR = "__mission__"

    private val QUERY_SPLIT = Regex("""\s+""")

    fun matchesStatus(status: WorkerStatus, filter: RosterStatusFilter): Boolean = when (filter) {
        RosterStatusFilter.All -> true
        RosterStatusFilter.NeedsInput -> status == WorkerStatus.NeedsInput
        RosterStatusFilter.Working -> status == WorkerStatus.Working || status == WorkerStatus.Starting
        RosterStatusFilter.Done -> status == WorkerStatus.Done
        RosterStatusFilter.Ready -> status == WorkerStatus.Idle
        RosterStatusFilter.Asleep -> status.asleep
    }

    /** Repository or folder label for a floor: `owner/repo` on GitHub/GitLab, `Home`, `Folder`, or its checkout folder when distinct from the floor name. */
    fun repoLabel(floor: FloorInfo?): String? {
        if (floor == null) return null
        if (floor.home) return "Home"
        floor.repo?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        if (floor.plain) return "Folder"
        val tail = floor.dir.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\').trim()
        return tail.takeIf { it.isNotEmpty() && !it.equals(floor.name.trim(), ignoreCase = true) }
    }

    /** Short repo name when space is tight (`nikships/droid-office` -> `droid-office`), or full slug when unambiguous clarity helps. */
    fun extraRepoLabels(worker: WorkerInfo): List<String> =
        worker.repos.mapNotNull { r -> r.repo?.trim()?.takeIf { it.isNotEmpty() } ?: r.name.trim().takeIf { it.isNotEmpty() } }.distinct()

    /** Context line for an AskCard on the cross-floor Workers tab: names the floor, repo and branch. */
    fun whereLabel(worker: WorkerInfo, floor: FloorInfo?): String? {
        if (worker.id == ORCHESTRATOR_ID || worker.remote) return "Mission Control"
        val floorName = floor?.name?.trim()?.takeIf { it.isNotEmpty() } ?: floor?.id?.takeIf { it.isNotBlank() }
        val repo = repoLabel(floor)?.takeUnless { it.equals(floorName, ignoreCase = true) }
        val branch = worker.worktree?.branch?.trim()?.takeIf { it.isNotEmpty() }
        return listOfNotNull(floorName, repo, branch).joinToString(" · ").ifBlank { null }
    }

    private fun seatWords(deskId: String): String = when {
        deskId.startsWith("desk-") -> "desk ${deskId.removePrefix("desk-")}"
        deskId.startsWith("beanbag-") -> "beanbag ${deskId.removePrefix("beanbag-")}"
        else -> deskId
    }

    fun matchesQuery(
        row: BuildingWorkerRow,
        tokens: List<String>,
        modelName: ((String) -> String?)? = null,
    ): Boolean {
        if (tokens.isEmpty()) return true
        val w = row.worker
        val floor = row.floor
        val modelId = Workers.modelId(w)
        val resolvedModel = modelId?.let { modelName?.invoke(it) ?: Models.displayName(it) }
        val pr = Workers.pr(w, row.pulls)
        val fields = buildList {
            add(w.name)
            add(w.id)
            if (w.deskId.isNotBlank()) {
                add(w.deskId)
                add(seatWords(w.deskId))
            }
            Workers.title(w)?.let(::add)
            Workers.detail(w)?.let(::add)
            w.activity?.let(::add)
            w.prompt?.let(::add)
            w.todos?.current?.let(::add)
            w.ask?.let { ask ->
                if (ask.isPermission) add(Asks.permissionLine(ask))
                ask.tool?.let(::add)
                ask.command?.let(::add)
                ask.file?.let(::add)
                ask.summary?.let(::add)
                for (q in ask.questions) {
                    add(q.question)
                    q.topic?.let(::add)
                    addAll(q.options)
                }
            }
            if (row.kind == RosterKind.Orchestrator) {
                add("orchestrator")
                add("mission control")
                row.blocked?.let(::add)
            } else if (row.kind == RosterKind.Bot || w.remote) {
                add("external")
                add("bot")
                add("mission control")
            }
            floor?.let {
                add(it.name)
                add(it.id)
                it.branch?.let(::add)
                repoLabel(it)?.let(::add)
            }
            w.worktree?.branch?.let(::add)
            for (r in w.repos) {
                add(r.name)
                r.repo?.let(::add)
                add(r.branch)
            }
            w.cloud?.let { c ->
                c.where?.let(::add)
                add(c.computerName)
                c.environmentName?.let(::add)
            }
            modelId?.let(::add)
            resolvedModel?.let(::add)
            Workers.effort(w)?.let { add(EffortDial.label(it)) }
            if (w.createdBy.isNotBlank()) add(w.createdBy)
            row.leadName?.let(::add)
            w.team?.leadName?.takeIf { it.isNotBlank() }?.let(::add)
            pr?.let { (_, ref) ->
                if (ref.number > 0) {
                    add("#${ref.number}")
                    add("pr #${ref.number}")
                    add("pr#${ref.number}")
                    add(ref.number.toString())
                }
            }
            add(Workers.statusWord(w.state, w.acked))
            add(w.status)
            if (w.isShell) add("shell")
            if (w.isCloud) add("cloud")
            if (w.isSubagent) {
                add("subagent")
                add("team")
            }
        }

        return tokens.all { token -> fields.any { it.contains(token, ignoreCase = true) } }
    }

    fun queryTokens(query: String): List<String> =
        query.trim().lowercase().split(QUERY_SPLIT).filter { it.isNotEmpty() }

    /**
     * Builds the complete cross-floor roster, status/floor counts, and waiting queue in one pass.
     */
    fun build(
        floors: List<FloorInfo>,
        workersByFloor: Map<String, Collection<WorkerInfo>>,
        pullsByFloor: Map<String, List<GhPull>>,
        mission: MissionControlState?,
        screens: Map<String, ScreenState>,
        statusFilter: RosterStatusFilter = RosterStatusFilter.All,
        floorFilter: String = ALL_FLOORS,
        query: String = "",
        modelName: ((String) -> String?)? = null,
    ): BuildingRosterView {
        val floorMap = floors.associateBy { it.id }
        val floorRank = floors.mapIndexed { index, f -> f.id to index }.toMap()
        val orderedFloorIds = buildList {
            floors.forEach { add(it.id) }
            workersByFloor.keys.filter { it !in floorRank }.sorted().forEach(::add)
        }

        val candidates = ArrayList<BuildingWorkerRow>()
        if (mission != null) {
            val orch = mission.orchestrator
            if (orch.settings.on) {
                val w = orch.agent?.worker ?: WorkerInfo(
                    id = ORCHESTRATOR_ID,
                    name = ORCHESTRATOR_NAME,
                    color = ORCHESTRATOR_COLOR,
                    status = "idle",
                )
                candidates += BuildingWorkerRow(
                    worker = w,
                    kind = RosterKind.Orchestrator,
                    floorId = MISSION_FLOOR,
                    blocked = MissionControl.orchestratorBlocked(orch),
                    teamCount = MissionControl.team(orch).size,
                )
            }
            for (bot in mission.bots) {
                candidates += BuildingWorkerRow(
                    worker = bot.worker,
                    kind = RosterKind.Bot,
                    floorId = MISSION_FLOOR,
                    teamCount = bot.team.size,
                    botLastUsedAt = bot.lastUsedAt,
                )
            }
        }

        val seenDeskIds = HashSet<String>()
        for (fId in orderedFloorIds) {
            val list = workersByFloor[fId].orEmpty()
            val fInfo = floorMap[fId]
            val pulls = pullsByFloor[fId].orEmpty()
            for (w in list) {
                if (!MissionControl.isDeskWorker(w, mission)) continue
                if (!seenDeskIds.add(w.id)) continue
                val remoteBot = mission == null && w.remote
                candidates += BuildingWorkerRow(
                    worker = w,
                    kind = if (remoteBot) RosterKind.Bot else RosterKind.Desk,
                    floorId = if (remoteBot) MISSION_FLOOR else fId,
                    floor = if (remoteBot) null else fInfo,
                    pulls = pulls,
                )
            }
        }

        // Attach known lead names to every subagent, even if its lead is on another floor or Mission Control.
        val byId = candidates.associateBy { it.worker.id }
        val enriched = candidates.map { row ->
            val leadId = row.worker.lead
            val leadRow = leadId?.let(byId::get)
            val resolvedLeadName = leadRow?.worker?.name?.ifBlank { null }
                ?: row.worker.team?.leadName?.ifBlank { null }
            val crossFloor = leadRow != null && leadRow.floorId != row.floorId
            row.copy(leadName = resolvedLeadName, crossFloorLead = crossFloor)
        }

        val totalSummary = summarize(enriched)

        val floorWaiting = HashMap<String, Int>()
        for (row in enriched) {
            if (row.kind != RosterKind.Bot && !row.worker.remote && row.worker.state == WorkerStatus.NeedsInput) {
                val key = row.floorId ?: continue
                floorWaiting[key] = (floorWaiting[key] ?: 0) + 1
            }
        }

        val tokens = queryTokens(query)
        val queryMatched = if (tokens.isEmpty()) enriched else enriched.filter { matchesQuery(it, tokens, modelName) }

        val effectiveFloorFilter = when {
            floorFilter == ALL_FLOORS -> ALL_FLOORS
            floorFilter == MISSION_FLOOR && enriched.any { it.floorId == MISSION_FLOOR } -> MISSION_FLOOR
            orderedFloorIds.contains(floorFilter) -> floorFilter
            else -> ALL_FLOORS
        }

        val floorScoped = if (effectiveFloorFilter == ALL_FLOORS) queryMatched else queryMatched.filter { it.floorId == effectiveFloorFilter }
        val statusCounts = RosterStatusFilter.entries.associateWith { filter ->
            floorScoped.count { matchesStatus(it.worker.state, filter) }
        }

        val statusScoped = queryMatched.filter { matchesStatus(it.worker.state, statusFilter) }
        val floorCounts = buildMap {
            put(ALL_FLOORS, statusScoped.size)
            for (fId in orderedFloorIds) {
                put(fId, statusScoped.count { it.floorId == fId })
            }
            if (enriched.any { it.floorId == MISSION_FLOOR }) {
                put(MISSION_FLOOR, statusScoped.count { it.floorId == MISSION_FLOOR })
            }
        }

        val visible = floorScoped.filter { matchesStatus(it.worker.state, statusFilter) }
        val arranged = arrangeRows(visible, floorRank)

        val showAsks = statusFilter == RosterStatusFilter.All || statusFilter == RosterStatusFilter.NeedsInput
        val askCandidates = if (!showAsks) emptyList() else floorScoped
            .filter { it.kind != RosterKind.Bot && !it.worker.remote && it.worker.state == WorkerStatus.NeedsInput }
            .map { it.worker }
        val asks = Asks.queue(askCandidates, screens)

        return BuildingRosterView(
            totalSummary = totalSummary,
            statusCounts = statusCounts,
            floorCounts = floorCounts,
            floorWaiting = floorWaiting,
            asks = asks,
            rows = arranged,
        )
    }

    private fun summarize(rows: List<BuildingWorkerRow>): RosterSummary {
        var waiting = 0
        var working = 0
        var done = 0
        var unackedDone = 0
        var ready = 0
        var asleep = 0
        for (r in rows) {
            val w = r.worker
            when (w.state) {
                WorkerStatus.NeedsInput -> if (r.kind != RosterKind.Bot && !w.remote) waiting++
                WorkerStatus.Working, WorkerStatus.Starting -> working++
                WorkerStatus.Done -> {
                    done++
                    if (!w.acked && !w.isSubagent && r.kind != RosterKind.Bot && !w.remote) unackedDone++
                }
                WorkerStatus.Idle -> ready++
                WorkerStatus.Exited, WorkerStatus.Offline -> asleep++
                WorkerStatus.Unknown -> Unit
            }
        }
        return RosterSummary(
            total = rows.size,
            waiting = waiting,
            working = working,
            done = done,
            unackedDone = unackedDone,
            ready = ready,
            asleep = asleep,
        )
    }

    private fun rowPriority(row: BuildingWorkerRow): Int {
        if (row.kind == RosterKind.Bot) {
            return when (row.worker.state) {
                WorkerStatus.Working, WorkerStatus.Starting -> 3
                WorkerStatus.Done, WorkerStatus.Idle -> 5
                else -> 7
            }
        }
        return Workers.priority(row.worker)
    }

    private fun arrangeRows(rows: List<BuildingWorkerRow>, floorRank: Map<String, Int>): List<BuildingWorkerRow> {
        if (rows.isEmpty()) return emptyList()
        val byId = rows.associateBy { it.worker.id }
        val subsOf = rows.mapNotNull { r ->
            val lead = r.worker.lead
            if (lead == null || lead == r.worker.id || !byId.containsKey(lead)) null else lead to r
        }.groupBy({ it.first }, { it.second })
        val roots = rows.filter { r -> r.worker.lead == null || r.worker.lead == r.worker.id || !byId.containsKey(r.worker.lead) }

        fun floorOrderOf(r: BuildingWorkerRow): Int = when (r.floorId) {
            MISSION_FLOOR -> -1
            null -> Int.MAX_VALUE
            else -> floorRank[r.floorId] ?: (Int.MAX_VALUE - 1)
        }

        val itemOrder = compareBy<BuildingWorkerRow>(::rowPriority)
            .thenBy { r ->
                val s = r.worker.state
                if (s == WorkerStatus.NeedsInput || s == WorkerStatus.Done) r.worker.waitingSince ?: Long.MAX_VALUE else 0L
            }
            .thenBy(::floorOrderOf)
            .thenBy { it.worker.createdAt }
            .thenBy { it.worker.id }

        fun collectSubtree(root: BuildingWorkerRow): List<BuildingWorkerRow> {
            val visited = HashSet<String>()
            val tree = ArrayList<BuildingWorkerRow>()
            fun walk(node: BuildingWorkerRow) {
                if (!visited.add(node.worker.id)) return
                tree += node
                subsOf[node.worker.id]?.forEach(::walk)
            }
            walk(root)
            return tree
        }

        val subtrees = roots.associate { it.worker.id to collectSubtree(it) }
        val groupPriority = subtrees.mapValues { (_, tree) -> tree.minOf(::rowPriority) }
        val groupWait = subtrees.mapValues { (_, tree) ->
            val urgent = tree.filter { it.worker.state == WorkerStatus.NeedsInput || (it.worker.state == WorkerStatus.Done && !it.worker.acked) }
            urgent.minOfOrNull { it.worker.waitingSince ?: Long.MAX_VALUE } ?: Long.MAX_VALUE
        }

        val sortedRoots = roots.sortedWith(
            compareBy<BuildingWorkerRow> { groupPriority[it.worker.id] ?: 9 }
                .thenBy { groupWait[it.worker.id] ?: Long.MAX_VALUE }
                .then(itemOrder),
        )

        val out = ArrayList<BuildingWorkerRow>(rows.size)
        val emitted = HashSet<String>()
        fun emit(node: BuildingWorkerRow, depth: Int, parent: BuildingWorkerRow?) {
            if (!emitted.add(node.worker.id)) return
            val children = subsOf[node.worker.id].orEmpty().sortedWith(itemOrder)
            out += node.copy(
                depth = depth.coerceAtMost(2),
                subagents = children.size,
                leadName = if (parent != null) parent.worker.name.ifBlank { node.leadName } else node.leadName,
                crossFloorLead = if (parent != null) parent.floorId != node.floorId else node.crossFloorLead,
            )
            for (child in children) emit(child, depth + 1, node)
        }
        for (root in sortedRoots) emit(root, 0, null)
        // Safety net for cyclic lead references: never drop any visible worker.
        rows.filter { it.worker.id !in emitted }.sortedWith(itemOrder).forEach { emit(it, 0, null) }
        return out
    }
}
