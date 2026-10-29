package ai.factory.droidoffice.core

/** The immutable destination of an alert, its actions, and any success/refusal shown afterwards. */
data class NotificationTarget(val office: String, val floor: String, val worker: String) {
    init {
        require(ID.matches(office) && ID.matches(floor) && ID.matches(worker))
    }

    /** IDs cannot contain slashes, so distinct destinations also have distinct intent/notification keys. */
    val key: String get() = "$office/$floor/$worker"

    fun current(activeOffice: String?, office: String?, floor: String?, ready: Boolean, workerPresent: Boolean): Boolean =
        ready && workerPresent && activeOffice == this.office && office == this.office && floor == this.floor

    companion object {
        private val ID = Regex("^[A-Za-z0-9_\\-:.]{1,64}$")

        fun parse(office: String?, floor: String?, worker: String?): NotificationTarget? {
            if (office == null || floor == null || worker == null) return null
            if (!ID.matches(office) || !ID.matches(floor) || !ID.matches(worker)) return null
            return NotificationTarget(office, floor, worker)
        }
    }
}
