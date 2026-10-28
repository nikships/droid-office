package ai.factory.droidoffice.core

import kotlinx.serialization.Serializable

enum class HostUpdateAction(val wire: String) { CHECK("check"), INSTALL("install") }

/** The paired Mac's app update, independent of this phone's APK updater. */
@Serializable
data class HostUpdateState(
    val supported: Boolean = false,
    val currentVersion: String = "",
    val phase: String = "unavailable",
    val title: String = "Host updates unavailable",
    val detail: String? = null,
    val progress: Float? = null,
    val version: String? = null,
    val busy: Boolean = false,
    val canInstall: Boolean = false,
) {
    val restarting: Boolean get() = phase == "restarting" || phase == "preparing"
}
