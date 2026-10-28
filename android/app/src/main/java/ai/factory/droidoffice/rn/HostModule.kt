package ai.factory.droidoffice.rn

import ai.factory.droidoffice.SetupActivity
import ai.factory.droidoffice.core.OfficeJson
import ai.factory.droidoffice.core.ToolPolicy
import ai.factory.droidoffice.graph
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.HapticFeedbackConstants
import androidx.activity.ComponentActivity
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.edit
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import java.net.URLEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/**
 * `DroidOfficeHost` (src/mobile/specs/NativeDroidOfficeHost.ts): the React Native side's door to the
 * app's connection, over [NativeHost]. Every value crosses as JSON text; nothing it returns carries a
 * token, an office address or a file path.
 */
class HostModule(context: ReactApplicationContext) : NativeDroidOfficeHostSpec(context) {
    private val graph = context.applicationContext.graph
    private val host = graph.host
    private val main = Handler(Looper.getMainLooper())
    private val emitter: (String) -> Unit = { json -> reactApplicationContext.emitDeviceEvent(EVENT, json) }

    override fun initialize() {
        super.initialize()
        main.post { host.attach(emitter) }
    }

    override fun invalidate() {
        main.post { host.detach(emitter) }
        super.invalidate()
    }

    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post(block)
    }

    override fun bootstrap(promise: Promise) = onMain {
        // Events from here on go to the page; it subscribed before asking.
        host.attachIfNeeded(emitter)
        promise.resolve(host.bootstrap())
    }

    override fun send(json: String): Boolean = host.send(json)

    override fun request(json: String, promise: Promise) = onMain { host.request(json) { promise.resolve(it) } }

    override fun hold(workerId: String): Double {
        if (!NativeHost.ID.matches(workerId)) return 0.0
        return host.tokens.hold(workerId).toDouble()
    }

    override fun release(token: Double) = host.tokens.release(token.toLong())

    override fun http(json: String, promise: Promise) {
        val req = runCatching { OfficeJson.parseToJsonElement(json) as? JsonObject }.getOrNull()
        val method = (req?.get("method") as? JsonPrimitive)?.contentOrNull
        val path = (req?.get("path") as? JsonPrimitive)?.contentOrNull
        if (req == null || method == null || path == null || !ToolPolicy.allowed(method, path)) {
            promise.reject("refused", "The phone doesn't send that request to the office.")
            return
        }
        val query = (req["query"] as? JsonObject)?.entries?.joinToString("&") { (k, v) ->
            enc(k) + "=" + enc((v as? JsonPrimitive)?.contentOrNull.orEmpty())
        }?.takeIf { it.isNotEmpty() }
        val body = req["json"]?.takeIf { it !is JsonNull }?.toString()?.toByteArray(Charsets.UTF_8)
        if (!ToolPolicy.validQuery(query) || (body?.size ?: 0) > ToolPolicy.JSON_MAX) {
            promise.reject("refused", "The phone doesn't send that request to the office.")
            return
        }
        onMain {
            val office = graph.connection.log.link.office
            val epoch = graph.connection.liveEpoch
            if (office == null || epoch == null) {
                promise.reject("offline", "Disconnected. Nothing was sent.")
                return@onMain
            }
            host.scope.launch {
                graph.bridge.http(office, epoch, ToolHttpRequest(method, path, query, if (body != null) "application/json" else null, body))
                    .onSuccess { r ->
                        val text = r.body.toString(Charsets.UTF_8)
                        val parsed = if (r.contentType?.contains("json", ignoreCase = true) == true) runCatching { OfficeJson.parseToJsonElement(text) }.getOrNull() else null
                        promise.resolve(buildJsonObject {
                            put("status", r.status)
                            put("body", parsed ?: JsonPrimitive(text))
                        }.toString())
                    }
                    .onFailure { promise.reject("failed", it.message ?: "Couldn't reach the office.") }
            }
        }
    }

    override fun pickImages(floor: String, max: Double, promise: Promise) = onMain {
        val n = max.toInt().coerceAtMost(PICTURES_MAX)
        val activity = reactApplicationContext.currentActivity as? ComponentActivity
        if (n <= 0 || activity == null || !NativeHost.ID.matches(floor)) {
            promise.resolve("[]")
            return@onMain
        }
        val key = "pick-${System.nanoTime()}"
        val request = PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
        val done: (List<android.net.Uri>) -> Unit = { uris -> upload(floor, uris.take(n), promise) }
        if (n == 1) {
            lateinit var launcher: androidx.activity.result.ActivityResultLauncher<PickVisualMediaRequest>
            launcher = activity.activityResultRegistry.register(key, ActivityResultContracts.PickVisualMedia()) { uri ->
                launcher.unregister()
                done(listOfNotNull(uri))
            }
            launcher.launch(request)
        } else {
            lateinit var launcher: androidx.activity.result.ActivityResultLauncher<PickVisualMediaRequest>
            launcher = activity.activityResultRegistry.register(key, ActivityResultContracts.PickMultipleVisualMedia(n)) { uris ->
                launcher.unregister()
                done(uris)
            }
            launcher.launch(request)
        }
    }

    /** Uploads each picture to the office and floor live now, remembering where each went. */
    private fun upload(floor: String, uris: List<android.net.Uri>, promise: Promise) {
        if (uris.isEmpty()) return promise.resolve("[]")
        val live = host.liveEndpoint() ?: return promise.reject("offline", "Disconnected. Nothing was uploaded.")
        val (office, endpoint) = live
        host.scope.launch {
            val out = buildJsonArray {
                for (uri in uris) {
                    val picture = withContext(Dispatchers.IO) { runCatching { Pictures.load(reactApplicationContext, uri) }.getOrNull() } ?: continue
                    val id = graph.api.stageImage(endpoint.base, endpoint.auth, floor, picture.name, picture.type, picture.bytes).getOrNull() ?: continue
                    host.recordImage(id, office, floor, endpoint)
                    add(buildJsonObject {
                        put("id", id)
                        put("name", picture.name)
                        picture.preview?.let { put("preview", it) }
                    })
                }
            }
            promise.resolve(out.toString())
        }
    }

    override fun forgetImage(floor: String, id: String, office: String?) = onMain { host.forgetImage(floor, id, office) }

    override fun layoutLoad(office: String, promise: Promise) {
        promise.resolve(if (NativeHost.ID.matches(office)) layouts().getString(office, null) else null)
    }

    override fun layoutSave(office: String, json: String) {
        if (!NativeHost.ID.matches(office) || json.length > LAYOUT_MAX) return
        layouts().edit { putString(office, json) }
    }

    private fun layouts() = reactApplicationContext.getSharedPreferences("layouts", android.content.Context.MODE_PRIVATE)

    override fun openPairing() = setup(SetupActivity.PAIR)

    override fun openOffices() = setup(SetupActivity.OFFICES)

    override fun openSettings() = setup(SetupActivity.SETTINGS)

    private fun setup(screen: String) {
        val from = reactApplicationContext.currentActivity
        val intent = Intent(reactApplicationContext, SetupActivity::class.java).putExtra(SetupActivity.EXTRA_SCREEN, screen)
        if (from != null) from.startActivity(intent) else reactApplicationContext.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    override fun selectOffice(officeId: String) = onMain {
        if (graph.store.snapshot.value.offices.any { it.id == officeId }) host.scope.launch { graph.store.setActive(officeId) }
    }

    override fun haptic(kind: String) = onMain {
        if (!graph.store.snapshot.value.settings.haptics) return@onMain
        val view = reactApplicationContext.currentActivity?.window?.decorView ?: return@onMain
        val effect = when (kind) {
            "confirm" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
            "reject" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
            else -> HapticFeedbackConstants.CLOCK_TICK
        }
        view.performHapticFeedback(effect)
    }

    override fun screen(workerId: String): String? = host.screen(workerId)

    private companion object {
        const val EVENT = "DroidOfficeHost"
        const val PICTURES_MAX = 10
        const val LAYOUT_MAX = 64 * 1024

        fun enc(s: String): String = URLEncoder.encode(s, "UTF-8").replace("+", "%20")
    }
}
