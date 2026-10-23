package ai.factory.droidoffice.core

data class FloorMove(val floor: String, val before: String?)

object FloorOrder {
    fun changed(ids: List<String>, floor: String, before: String?): Boolean {
        val at = ids.indexOf(floor)
        return at >= 0 && (before == null || before in ids) && floor != before && ids.getOrNull(at + 1) != before
    }

    /** An accessible one-step move in the server's numbered order. */
    fun step(ids: List<String>, floor: String, delta: Int): FloorMove? {
        val from = ids.indexOf(floor)
        val to = from + delta
        if (from < 0 || delta !in listOf(-1, 1) || to !in ids.indices) return null
        val next = ids.toMutableList()
        next.removeAt(from)
        next.add(to, floor)
        return FloorMove(floor, next.getOrNull(to + 1))
    }
}
