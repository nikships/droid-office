package ai.factory.droidoffice.core

/** Immutable picker destination. Cleanup always uses this route, even after the selection expires. */
data class UploadTarget<Route>(val office: String, val floor: String, val epoch: Long, val route: Route) {
    fun matches(active: String?, currentFloor: String?, liveEpoch: Long?, liveRoute: Route?): Boolean =
        active == office && currentFloor == floor && liveEpoch == epoch && liveRoute == route
}
