package ai.factory.droidoffice.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The phone's default network, as far as reaching an office goes. */
data class NetState(
    val available: Boolean,
    /** Changes whenever the default network does (Wi-Fi to mobile data, another Wi-Fi): a cue to race the routes again. */
    val networkKey: String?,
    val wifi: Boolean,
    val vpn: Boolean,
)

class NetworkMonitor(context: Context) {
    private val cm = context.getSystemService(ConnectivityManager::class.java)
    private val _state = MutableStateFlow(read(cm.activeNetwork))
    val state: StateFlow<NetState> = _state.asStateFlow()

    init {
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                _state.value = read(network)
            }

            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                // Capabilities change often (signal, validation); only the kind of network matters here.
                val next = read(network, caps)
                if (next != _state.value) _state.value = next
            }

            override fun onLost(network: Network) {
                _state.value = NetState(available = false, networkKey = null, wifi = false, vpn = false)
            }
        })
    }

    private fun read(network: Network?, caps: NetworkCapabilities? = network?.let { cm.getNetworkCapabilities(it) }): NetState {
        if (network == null || caps == null) return NetState(false, null, wifi = false, vpn = false)
        val wifi = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        val vpn = caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
        return NetState(available = true, networkKey = "$network:${if (wifi) "w" else "m"}${if (vpn) "v" else ""}", wifi = wifi, vpn = vpn)
    }
}
