package ai.factory.droidoffice.rn

import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.viewmanagers.DroidOfficeTerminalManagerDelegate
import com.facebook.react.viewmanagers.DroidOfficeTerminalManagerInterface

/** `DroidOfficeTerminal` (src/mobile/specs/DroidOfficeTerminalNativeComponent.ts). */
class TerminalViewManager : SimpleViewManager<TerminalView>(), DroidOfficeTerminalManagerInterface<TerminalView> {
    private val delegate = DroidOfficeTerminalManagerDelegate(this)

    override fun getDelegate(): ViewManagerDelegate<TerminalView> = delegate

    override fun getName() = NAME

    override fun createViewInstance(context: ThemedReactContext) = TerminalView(context)

    @ReactProp(name = "workerId")
    override fun setWorkerId(view: TerminalView, value: String?) = view.setWorker(value)

    @ReactProp(name = "active")
    override fun setActive(view: TerminalView, value: Boolean) = view.setActive(value)

    @ReactProp(name = "fit")
    override fun setFit(view: TerminalView, value: String?) = view.setFit(value)

    override fun onDropViewInstance(view: TerminalView) {
        view.dispose()
        super.onDropViewInstance(view)
    }

    companion object {
        const val NAME = "DroidOfficeTerminal"
    }
}
