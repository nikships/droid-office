package ai.factory.droidoffice.core

/** One row of the droid list: a droid, indented under its lead when it's a subagent. */
data class WorkerRow(val worker: WorkerInfo, val depth: Int, val subagents: Int, val leadName: String?)

object Workers {
    /**
     * Who needs the owner first: a question or permission prompt, then a finished turn nobody has
     * looked at, then whoever is working, then the rest. Asleep droids sink to the bottom.
     */
    fun priority(w: WorkerInfo): Int = when (w.state) {
        WorkerStatus.NeedsInput -> 0
        WorkerStatus.Done -> if (w.acked) 4 else 1
        WorkerStatus.Working -> 2
        WorkerStatus.Starting -> 3
        WorkerStatus.Idle -> 5
        WorkerStatus.Exited -> 6
        WorkerStatus.Offline -> 7
        WorkerStatus.Unknown -> 8
    }

    private val order = compareBy<WorkerInfo>(::priority)
        // Whoever has waited longest goes first, like the office's N key.
        .thenBy { if (it.state == WorkerStatus.NeedsInput || it.state == WorkerStatus.Done) it.waitingSince ?: Long.MAX_VALUE else 0L }
        .thenBy { it.createdAt }
        .thenBy { it.id }

    /**
     * Desk droids sorted by [priority], each lead followed by its subagents. A lead's group sorts by
     * its most urgent member, so a subagent's question still lifts the group to the top. Board agents
     * at their kiosks come back separately.
     */
    fun arrange(all: Collection<WorkerInfo>): Pair<List<WorkerRow>, List<WorkerInfo>> {
        val stations = all.filter { it.isStation }.sortedWith(order)
        val desk = all.filterNot { it.isStation }
        val byId = desk.associateBy { it.id }
        val subsOf = desk.filter { it.lead != null && byId.containsKey(it.lead) }.groupBy { it.lead!! }
        val roots = desk.filter { it.lead == null || !byId.containsKey(it.lead) }
        val groupPriority = roots.associate { root ->
            root.id to (listOf(root) + subsOf[root.id].orEmpty()).minOf(::priority)
        }
        val rows = mutableListOf<WorkerRow>()
        val sortedRoots = roots.sortedWith(compareBy<WorkerInfo> { groupPriority[it.id] ?: 9 }.then(order))
        for (root in sortedRoots) {
            val subs = subsOf[root.id].orEmpty().sortedWith(order)
            rows += WorkerRow(root, 0, subs.size, null)
            for (s in subs) rows += WorkerRow(s, 1, 0, root.name)
        }
        return rows to stations
    }

    /** How long it has spent working: the stretches that ended, plus the one it's in now. */
    fun workedMs(w: WorkerInfo, now: Long): Long {
        val running = w.workingSince?.let { (now - it).coerceAtLeast(0) } ?: 0
        return (w.workedMs ?: 0) + running
    }

    fun duration(ms: Long): String {
        val s = ms / 1000
        return when {
            s < 60 -> "${s}s"
            s < 3600 -> "${s / 60}m"
            else -> "${s / 3600}h ${(s % 3600 / 60).toString().padStart(2, '0')}m"
        }
    }

    /** "3m ago" style, for when it started waiting. */
    fun ago(at: Long, now: Long): String {
        val s = ((now - at) / 1000).coerceAtLeast(0)
        return when {
            s < 10 -> "just now"
            s < 60 -> "${s}s ago"
            s < 3600 -> "${s / 60}m ago"
            s < 86_400 -> "${s / 3600}h ago"
            else -> "${s / 86_400}d ago"
        }
    }

    /** The model it's running, as the agent reports it, else the one it was hired on. */
    fun modelId(w: WorkerInfo): String? = w.activeModel ?: w.model

    fun effort(w: WorkerInfo): Effort? = Effort.of(w.activeEffort ?: w.effort)

    /** A model id short enough for a card: no `custom:` prefix or provider path. */
    fun shortModel(id: String): String = id.removePrefix("custom:").substringAfterLast(':').substringAfterLast('/')

    /** One line for a notification or a card: what it's asking when it needs input, else what it's on. */
    fun detail(w: WorkerInfo): String? = when (w.state) {
        WorkerStatus.NeedsInput -> w.activity ?: w.task?.summary
        else -> w.task?.summary ?: w.activity ?: w.prompt
    }?.takeIf { it.isNotBlank() }

    fun title(w: WorkerInfo): String? = w.task?.name?.takeIf { it.isNotBlank() } ?: w.title?.takeIf { it.isNotBlank() }

    enum class PrState { Open, Merged, Opening }

    /** Its pull request and where it stands: an open one wins over a merged one (see src/shared/status.ts). */
    fun pr(w: WorkerInfo, pulls: List<GhPull>, tasks: List<QueueTask>): Pair<PrState, PrRef>? {
        if (w.prOpening) return PrState.Opening to (w.pr ?: PrRef())
        val mine = buildSet {
            w.pr?.let { add(it.number) }
            tasks.filter { it.workerId == w.id }.mapNotNull { it.pr?.number }.forEach(::add)
        }
        val seen = pulls.filter { it.number in mine || (w.worktree != null && w.worktree.branch == it.headRefName) }
            .map { Triple(it.number, it.state, it.url) }.toMutableList()
        for (t in tasks) {
            val p = t.pr ?: continue
            if (t.workerId == w.id && seen.none { it.first == p.number }) seen += Triple(p.number, p.state, p.url)
        }
        w.pr?.let { p -> if (seen.none { it.first == p.number }) seen += Triple(p.number, "OPEN", p.url) }
        seen.firstOrNull { it.second == "OPEN" || it.second == "DRAFT" }?.let { return PrState.Open to PrRef(it.first, it.third) }
        seen.firstOrNull { it.second == "MERGED" }?.let { return PrState.Merged to PrRef(it.first, it.third) }
        return null
    }

    /**
     * A free desk for an office too old to pick one itself (`deskId: "auto"`): the lowest-numbered
     * desk nobody sits at. Desks are `desk-1`… in src/shared/layout.ts.
     */
    fun freeDesk(workers: Collection<WorkerInfo>, max: Int = 64): String {
        val taken = workers.map { it.deskId }.toSet()
        return (1..max).map { "desk-$it" }.firstOrNull { it !in taken } ?: "desk-1"
    }
}
