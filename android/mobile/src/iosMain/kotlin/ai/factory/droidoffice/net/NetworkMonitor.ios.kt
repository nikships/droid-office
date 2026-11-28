@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package ai.factory.droidoffice.net

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import platform.Network.*
import platform.darwin.dispatch_get_main_queue

class NetworkMonitor : OfficeNetwork {
    private val monitor = checkNotNull(nw_path_monitor_create())
    private val current = MutableStateFlow(NetState(false, null, wifi = false, vpn = false))
    override val state = current.asStateFlow()

    init {
        // Publish on one queue; a real path change (even Wi-Fi to Wi-Fi) re-races the office.
        var previous: nw_path_t = null
        var generation = 0L
        nw_path_monitor_set_queue(monitor, dispatch_get_main_queue())
        nw_path_monitor_set_update_handler(monitor) { path ->
            if (path != null && (previous == null || !nw_path_is_equal(previous, path))) {
                previous = path
                val up = nw_path_get_status(path) == nw_path_status_satisfied
                current.value = NetState(up, if (up) (++generation).toString() else null,
                    nw_path_uses_interface_type(path, nw_interface_type_wifi) || nw_path_uses_interface_type(path, nw_interface_type_wired),
                    nw_path_uses_interface_type(path, nw_interface_type_other))
            }
        }
        nw_path_monitor_start(monitor)
    }

    fun close() = nw_path_monitor_cancel(monitor)
}
