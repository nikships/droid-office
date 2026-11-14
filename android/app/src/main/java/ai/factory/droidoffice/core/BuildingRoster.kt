package ai.factory.droidoffice.core

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
    val grokBot: Boolean = false,
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
    /** Building-wide totals for the header summary and badge. */
    val totalSummary: RosterSummary,
    /** Waiting asks to pin at the top of the Workers tab. */
    val asks: List<PendingAsk>,
    /** Arranged worker rows across every floor and Mission Control. */
    val rows: List<BuildingWorkerRow>,
)

object BuildingRoster {
    const val MISSION_FLOOR = "__mission__"

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

    /**
     * Builds the complete cross-floor roster, summary, and waiting queue in one pass.
     */
    fun build(
        floors: List<FloorInfo>,
        workersByFloor: Map<String, Collection<WorkerInfo>>,
        pullsByFloor: Map<String, List<GhPull>>,
        mission: MissionControlState?,
        screens: Map<String, ScreenState>,
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
                    grokBot = bot.grokBot,
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

        // A building agent with no team has nothing to list; Office's Mission Control section still shows it, and its asks stay pinned.
        val leads = enriched.mapNotNullTo(HashSet()) { it.worker.lead }
        val listed = enriched.filter { it.kind == RosterKind.Desk || it.teamCount > 0 || it.worker.id in leads }

        val totalSummary = summarize(listed)

        val arranged = arrangeRows(listed, floorRank)

        val askCandidates = enriched
            .filter { it.kind != RosterKind.Bot && !it.worker.remote && it.worker.state == WorkerStatus.NeedsInput }
            .map { it.worker }
        val asks = Asks.queue(askCandidates, screens)

        return BuildingRosterView(
            totalSummary = totalSummary,
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
