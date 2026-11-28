package ai.factory.droidoffice.notify

import ai.factory.droidoffice.AppGraph
import ai.factory.droidoffice.core.*
import ai.factory.droidoffice.session.Answered
import ai.factory.droidoffice.session.OfficeData
import ai.factory.droidoffice.session.Phase
import ai.factory.droidoffice.ui.Incoming
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import platform.UserNotifications.*
import platform.darwin.NSObject

data class Banner(val workerId: String, val name: String, val color: String, val needsInput: Boolean, val detail: String?)

class Alerts internal constructor(private val graph: AppGraph, private val incoming: MutableStateFlow<Incoming?>) : NSObject(), UNUserNotificationCenterDelegateProtocol {
    private val center = UNUserNotificationCenter.currentNotificationCenter()
    val banners = MutableSharedFlow<Banner>(extraBufferCapacity = 8)
    private val categories = mutableMapOf<String, UNNotificationCategory>()
    private var baseline: Pair<String?, String?>? = null
    private var last = emptyMap<String, WorkerInfo>()
    private var waiting = emptyMap<String, Int>()
    private val shown = mutableMapOf<String, Menu?>()

    init {
        center.delegate = this
        graph.scope.launch { graph.connection.data.collect(::diff) }
        graph.scope.launch { graph.connection.screens.collect {
            val d = graph.connection.data.value
            val office = d.officeId ?: return@collect
            for ((id, before) in shown.toMap()) {
                val worker = d.worker(id) ?: continue
                val menu = graph.answers.current(id)
                if (worker.state == WorkerStatus.NeedsInput && menu != before) post(office, worker, menu, quiet = true)
            }
        } }
    }

    private fun diff(data: OfficeData) {
        val office = data.officeId ?: return
        if (!data.synced) return
        val key = office to data.floorId.takeUnless { data.hasBuildingRoster }
        val everyone = data.askable.associateBy { it.id }
        if (baseline == key) {
            val settings = graph.store.snapshot.value.settings
            for ((id, w) in everyone) {
                val prev = last[id] ?: continue
                val needs = w.state == WorkerStatus.NeedsInput
                if (prev.state != w.state && (needs && settings.notifyNeedsInput || w.state == WorkerStatus.Done && prev.state.busy && !w.isSubagent && settings.notifyDone)) {
                    if (!graph.visibility.foreground.value) post(office, w, graph.answers.current(id))
                    else if (graph.visibility.viewing.value != id) banners.tryEmit(Banner(id, w.name, w.color, needs, Workers.detail(w)))
                } else if (prev.state != w.state || w.acked && !prev.acked) cancel(id)
            }
            (last.keys - everyone.keys).forEach(::cancel)
            if (!data.hasBuildingRoster && !graph.visibility.foreground.value && settings.notifyNeedsInput) for (f in data.floors) {
                if (f.id != data.floorId && f.waiting > (waiting[f.id] ?: f.waiting)) deliver("floor:${f.id}", UNMutableNotificationContent().apply {
                    setTitle("${f.name}: ${f.waiting} waiting on you"); setBody("A worker on another floor needs an answer")
                    setUserInfo(mapOf("office" to office, "floor" to f.id)); setSound(UNNotificationSound.defaultSound())
                })
            }
        } else {
            shown.keys.toList().forEach(::cancel)
            baseline = key
        }
        last = everyone
        waiting = data.floors.associate { it.id to it.waiting }
    }

    private fun deliver(id: String, content: UNMutableNotificationContent) = center.addNotificationRequest(UNNotificationRequest.requestWithIdentifier(id, content, null), null)

    private fun post(office: String, w: WorkerInfo, menu: Menu?, quiet: Boolean = false) {
        val info = mutableMapOf<Any?, String>("office" to office, "worker" to w.id)
        menu?.let { info["menu"] = OfficeJson.encodeToString(Menu.serializer(), it) }
        val actions = if (menu?.multiSelect == true) emptyList() else menu?.choices.orEmpty().take(2).map { c ->
            UNNotificationAction.actionWithIdentifier("choice:${c.number}", c.label, UNNotificationActionOptionAuthenticationRequired)
        } + UNTextInputNotificationAction.actionWithIdentifier("reply", "Reply", UNNotificationActionOptionAuthenticationRequired, "Send", "Your reply")
        val category = "worker:${w.id}"
        categories[w.id] = UNNotificationCategory.categoryWithIdentifier(category, actions, emptyList<String>(), 0u)
        center.setNotificationCategories(categories.values.toSet())
        deliver(w.id, UNMutableNotificationContent().apply {
            setTitle(if (w.state == WorkerStatus.NeedsInput) "${w.name} needs you" else "${w.name} is done")
            setBody(menu?.question ?: Workers.detail(w) ?: if (w.state == WorkerStatus.NeedsInput) "Waiting on an answer" else "Finished its turn")
            setUserInfo(info); setCategoryIdentifier(category); setThreadIdentifier(office)
            if (!quiet) setSound(UNNotificationSound.defaultSound())
        })
        shown[w.id] = menu
    }

    fun cancel(workerId: String) {
        shown.remove(workerId)
        categories.remove(workerId)
        center.removeDeliveredNotificationsWithIdentifiers(listOf(workerId))
    }

    override fun userNotificationCenter(center: UNUserNotificationCenter, didReceiveNotificationResponse: UNNotificationResponse, withCompletionHandler: () -> Unit) {
        val response = didReceiveNotificationResponse
        val info = response.notification.request.content.userInfo
        val office = info["office"] as? String
        val id = info["worker"] as? String
        graph.scope.launch {
            try {
                if (office == null) return@launch
                if (response.actionIdentifier == UNNotificationDefaultActionIdentifier) {
                    incoming.value = if (id != null) Incoming.Worker(office, id) else (info["floor"] as? String)?.let { Incoming.Floor(office, it) }
                    return@launch
                }
                if (id == null || graph.store.snapshot.first { it.loaded }.active?.id != office) return@launch
                val menu = (info["menu"] as? String)?.let { OfficeJson.decodeFromString(Menu.serializer(), it) }
                val text = (response as? UNTextInputNotificationResponse)?.userText?.trim().orEmpty()
                val tag = "answer-$id"
                graph.connection.hold(tag)
                val sent = try { withTimeoutOrNull(10_000) {
                    graph.connection.link.first { it.phase == Phase.Connected && it.officeId == office }
                    graph.connection.data.first { it.synced && it.officeId == office }
                    if (menu == null) text.isNotBlank() && graph.connection.send(ClientMsg.prompt(id, text)) else {
                        graph.connection.screens.first { id in it }
                        val choice = response.actionIdentifier.removePrefix("choice:").toIntOrNull() ?: text.toIntOrNull()?.takeIf { n -> menu.choices.any { it.number == n } }
                        val result = if (choice != null) graph.answers.choose(id, menu, choice) else graph.answers.type(id, menu, text)
                        result == Answered.Sent
                    }
                } == true } finally { graph.connection.release(tag) }
                if (sent) cancel(id) else deliver(id, UNMutableNotificationContent().apply {
                    setTitle("Reply not confirmed"); setBody("Open the worker to check its current question."); setUserInfo(info)
                })
            } finally { withCompletionHandler() }
        }
    }
}
