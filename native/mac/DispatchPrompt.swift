import AppKit
import SwiftUI
import UserNotifications

@MainActor
final class DispatchPrompt: ObservableObject {
    @Published var prompt = ""
    @Published var model = "floor-default"
    @Published var resolved: ResolveResult?
    @Published var result: DispatchResult?
    @Published var error: String?
    @Published var busy = true
    @Published var attempted = false
    @Published var canClose = false
    @Published var notificationUnavailable = false
    private let urls: [URL]
    private var paths: [String] = []
    private var api: FinderAPI?
    private let requestId = UUID().uuidString
    init(urls: [URL]) { self.urls = urls }
    var valid: Bool { !busy && !attempted && resolved != nil && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && prompt.utf16.count <= 16000 }

    func resolve() async {
        do {
            let selection = urls
            paths = try await Task.detached { try FinderPolicy.paths(selection) }.value
            let client = try FinderAPI()
            api = client
            let value: ResolveResult = try await client.request("resolve", body: JSONEncoder().encode(ResolveRequest(paths: paths)))
            guard !value.groups.isEmpty, value.groups.count <= 5 else { throw FinderFailure.message("Select items in at most five projects.") }
            resolved = value
        } catch { self.error = error.localizedDescription }
        busy = false
    }

    func dispatch() async {
        guard valid, let api else { return }
        busy = true
        attempted = true
        do {
            // The same request ID belongs to this exact payload. Never replay a partial multi-project dispatch.
            let body = DispatchRequest(paths: paths, prompt: prompt, model: model, requestId: requestId)
            let value: DispatchResult = try await api.request("dispatch", body: JSONEncoder().encode(body))
            result = value
            if !value.errors.isEmpty { error = value.errors.map { "\($0.floorId): \($0.error)" }.joined(separator: "\n") }
            var notified = !value.dispatches.isEmpty
            for dispatch in value.dispatches {
                let delivered = await notify(dispatch)
                notified = notified && delivered
            }
            notificationUnavailable = !notified && !value.dispatches.isEmpty
            canClose = notified && value.errors.isEmpty
        } catch {
            self.error = error.localizedDescription + "\nThe result may be incomplete. Check Droid Office before submitting again. Nothing is queued."
        }
        busy = false
    }

    func openThread(_ dispatch: FinderDispatch) {
        guard let url = threadLink(dispatch.deepLink) else { return }
        NSWorkspace.shared.open(url)
    }

    private func notify(_ dispatch: FinderDispatch) async -> Bool {
        guard threadLink(dispatch.deepLink) != nil else { return false }
        let center = UNUserNotificationCenter.current()
        center.setNotificationCategories([UNNotificationCategory(identifier: "finder-dispatch",
            actions: [UNNotificationAction(identifier: "open-thread", title: "Open Thread", options: [.foreground])], intentIdentifiers: [])])
        center.delegate = FinderNotifications.shared
        do {
            guard try await center.requestAuthorization(options: [.alert, .sound]) else { return false }
            let content = UNMutableNotificationContent()
            content.title = "Dispatched to Droid Office"
            content.body = "Your worker is ready. Open Thread to follow the task."
            content.categoryIdentifier = "finder-dispatch"
            content.userInfo = ["deepLink": dispatch.deepLink]
            try await center.add(UNNotificationRequest(identifier: dispatch.leadId, content: content, trigger: nil))
            return true
        } catch { return false }
    }
}

func threadLink(_ raw: String) -> URL? {
    guard raw.utf8.count <= 2048, let url = URL(string: raw), let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
          c.scheme == "droid-office", c.host == "thread", c.user == nil, c.password == nil, c.port == nil,
          c.fragment == nil, let query = c.queryItems, query.count == 1, query[0].name == "floor",
          let floor = query[0].value, floor.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil,
          c.path.range(of: "^/[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil else { return nil }
    return url
}

final class FinderNotifications: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    static let shared = FinderNotifications()
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        defer { completionHandler() }
        guard [UNNotificationDefaultActionIdentifier, "open-thread"].contains(response.actionIdentifier),
              let raw = response.notification.request.content.userInfo["deepLink"] as? String,
              let url = threadLink(raw) else { return }
        DispatchQueue.main.async { NSWorkspace.shared.open(url) }
    }
}

struct DispatchView: View {
    @ObservedObject var model: DispatchPrompt
    let close: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Dispatch to Office").font(.title2).bold()
            if let resolved = model.resolved {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(resolved.groups) { group in
                            Text(group.floorName + (group.isNewFloor ? " (new floor)" : "")).bold()
                            ForEach(Array(group.relativePaths.enumerated()), id: \.offset) { _, path in
                                Text(path).font(.caption).textSelection(.enabled)
                            }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.frame(maxHeight: 120)
                Text("Task")
                TextEditor(text: $model.prompt).font(.body).frame(minHeight: 120).border(Color.secondary.opacity(0.3))
                    .disabled(model.attempted)
                Text("\(model.prompt.utf16.count) / 16000").font(.caption).foregroundStyle(.secondary)
                Picker("Model", selection: $model.model) {
                    Text("Floor default").tag("floor-default")
                    ForEach(resolved.models) { item in Text(item.label).tag(item.id) }
                }.disabled(model.attempted)
            }
            if model.busy { ProgressView(model.attempted ? "Dispatching…" : "Resolving selected items…") }
            if let error = model.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if model.notificationUnavailable {
                Text("Dispatched. Notifications are unavailable; use Open Thread below.").foregroundStyle(.secondary)
            }
            if let result = model.result {
                ForEach(result.dispatches) { dispatch in
                    Button("Open Thread · \(dispatch.floorId)") { model.openThread(dispatch) }
                }
            }
            Spacer(minLength: 0)
            HStack {
                Spacer()
                Button(model.attempted ? "Close" : "Cancel", action: close).keyboardShortcut(.cancelAction)
                if !model.attempted {
                    Button("Dispatch") {
                        Task {
                            await model.dispatch()
                            if model.canClose { close() }
                        }
                    }
                        .keyboardShortcut(.defaultAction).disabled(!model.valid)
                }
            }
        }.padding(20).frame(minWidth: 480, minHeight: 420)
    }
}
