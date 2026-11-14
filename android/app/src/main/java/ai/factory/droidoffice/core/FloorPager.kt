package ai.factory.droidoffice.core

/**
 * The Office tab lays the floors side by side in the building's order, as the chips are numbered, and
 * a sideways drag slides between them under the finger. The office moves this phone to a floor only
 * once a slide settles on it, so for a moment the page shown and the office's floor can differ.
 */
object FloorPager {
    /** The page showing [floorId], or null when it isn't one of [ids]. */
    fun page(ids: List<String>, floorId: String?): Int? = ids.indexOf(floorId).takeIf { it >= 0 }

    /**
     * The floor to ask the office for once the pager settles on [page]: null when this phone already
     * asked for it ([requested]), or nothing is on its way and the office is already there ([floorId]).
     * Settling back on [floorId] while another floor is on its way asks for [floorId] again.
     */
    fun request(ids: List<String>, page: Int, floorId: String?, requested: String?): String? {
        val id = ids.getOrNull(page) ?: return null
        return id.takeIf { it != (requested ?: floorId) }
    }

    /**
     * Whether the pager should slide to the office's floor [floorId]. Not while a floor this phone asked
     * for ([requested]) is still on its way: the views the office sends before it would drag the pager
     * back through floors the finger already left.
     */
    fun follows(floorId: String?, requested: String?): Boolean = requested == null || requested == floorId

    /**
     * The workers on [floor]'s page: the live list for the floor the phone is on, the building roster for
     * the others, and null while the phone can't know them (an office that sends no roster).
     */
    fun workers(floor: FloorInfo, current: String?, workers: Map<String, WorkerInfo>, building: Map<String, Map<String, WorkerInfo>>): Collection<WorkerInfo>? =
        if (floor.id == current) workers.values else building[floor.id]?.values ?: emptyList<WorkerInfo>().takeIf { floor.workers == 0 }

    /** The pull requests on [floor]'s page, for the cards' PR badges. */
    fun pulls(floor: FloorInfo, current: String?, pulls: List<GhPull>, building: Map<String, List<GhPull>>): List<GhPull> =
        if (floor.id == current) pulls else building[floor.id].orEmpty()
}
