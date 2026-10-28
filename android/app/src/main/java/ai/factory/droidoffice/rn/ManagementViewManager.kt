package ai.factory.droidoffice.rn

import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.viewmanagers.DroidOfficeManagementManagerDelegate
import com.facebook.react.viewmanagers.DroidOfficeManagementManagerInterface

class ManagementViewManager(private val host: ManagementHost) :
    SimpleViewManager<ManagementView>(), DroidOfficeManagementManagerInterface<ManagementView> {
    private val delegate = DroidOfficeManagementManagerDelegate(this)
    override fun getDelegate(): ViewManagerDelegate<ManagementView> = delegate
    override fun getName() = "DroidOfficeManagement"
    override fun createViewInstance(context: ThemedReactContext) = ManagementView(context, host)

    @ReactProp(name = "tool")
    override fun setTool(view: ManagementView, value: String?) { view.tool = value.orEmpty() }

    @ReactProp(name = "floor")
    override fun setFloor(view: ManagementView, value: String?) { view.floor = value.orEmpty() }

    @ReactProp(name = "params")
    override fun setParams(view: ManagementView, value: String?) { view.setParams(value) }

    override fun onAfterUpdateTransaction(view: ManagementView) {
        super.onAfterUpdateTransaction(view)
        view.applyProps()
    }

    override fun getExportedCustomDirectEventTypeConstants(): Map<String, Any> =
        mapOf("topToolEvent" to mapOf("registrationName" to "onToolEvent"))

    override fun onDropViewInstance(view: ManagementView) {
        view.dispose()
        super.onDropViewInstance(view)
    }
}
