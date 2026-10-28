package ai.factory.droidoffice.rn

import ai.factory.droidoffice.graph
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.uimanager.ViewManager

/** The app's own module and views for React Native. */
class HostPackage : BaseReactPackage() {
    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        if (name == NativeDroidOfficeHostSpec.NAME) HostModule(reactContext) else null

    override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
        mapOf(
            NativeDroidOfficeHostSpec.NAME to ReactModuleInfo(
                NativeDroidOfficeHostSpec.NAME,
                HostModule::class.java.name,
                canOverrideExistingModule = false,
                needsEagerInit = true,
                isCxxModule = false,
                isTurboModule = true,
            ),
        )
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<in Nothing, in Nothing>> =
        listOf(TerminalViewManager(), ManagementViewManager(reactContext.applicationContext.graph.bridge))
}
