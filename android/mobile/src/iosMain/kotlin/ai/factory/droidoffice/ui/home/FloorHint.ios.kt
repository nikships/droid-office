package ai.factory.droidoffice.ui.home

import platform.Foundation.NSUserDefaults

internal fun rememberFloorOrderHint() = FloorOrderHint

internal object FloorOrderHint {
    private val prefs = NSUserDefaults.standardUserDefaults
    private val show by lazy {
        val launches = prefs.integerForKey("floor_order_launches")
        prefs.setInteger(launches + 1, "floor_order_launches")
        launches < 3
    }
    fun shown() = !prefs.boolForKey("floor_order_dragged") && show
    fun learned() = prefs.setBool(true, "floor_order_dragged")
}
