import AppKit
import FinderSync

@objc(FinderSync)
final class FinderSync: FIFinderSync {
    private var online = false
    private var checked = Date.distantPast
    private var checking = false

    override init() {
        super.init()
        FIFinderSyncController.default().directoryURLs = [URL(fileURLWithPath: "/")]
        refresh()
    }

    override func beginObservingDirectory(at url: URL) { refresh() }

    private func refresh() {
        guard !checking, Date().timeIntervalSince(checked) > 3 else { return }
        checking = true
        Task { @MainActor in
            self.online = await Task.detached {
                do {
                    let status: APIStatus = try await FinderAPI().request("status")
                    return status.ok
                } catch { return false }
            }.value
            self.checking = false
            self.checked = Date()
        }
    }

    override func menu(for menuKind: FIMenuKind) -> NSMenu? {
        let controller = FIFinderSyncController.default()
        let urls: [URL]
        if menuKind == .contextualMenuForContainer {
            urls = controller.targetedURL().map { [$0] } ?? []
        } else {
            urls = controller.selectedItemURLs() ?? controller.targetedURL().map { [$0] } ?? []
        }
        guard !urls.isEmpty, urls.count <= 100,
              urls.allSatisfy({ $0.isFileURL && FinderPolicy.allowedPath($0.path, home: FinderPolicy.home) }) else { return nil }
        refresh() // Never wait for the network or Keychain in Finder's menu callback.
        let menu = NSMenu()
        menu.autoenablesItems = false
        let isOnline = online && Date().timeIntervalSince(checked) < 15
        let item = NSMenuItem(title: isOnline ? "Dispatch to Office…" : "Open Droid Office",
                              action: isOnline ? #selector(dispatchSelection(_:)) : #selector(openOffice(_:)), keyEquivalent: "")
        item.target = self
        // Finder copies the menu across processes. Only supported item fields survive.
        item.tag = menuKind == .contextualMenuForContainer ? 1 : 0
        item.isEnabled = true
        menu.addItem(item)
        return menu
    }

    @objc private func openOffice(_ sender: Any?) {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: FinderPolicy.appID) else { return }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
    }

    @objc private func dispatchSelection(_ sender: NSMenuItem) {
        let controller = FIFinderSyncController.default()
        let selected = controller.selectedItemURLs().flatMap { $0.isEmpty ? nil : $0 }
        let urls = (sender.tag == 1 ? nil : selected) ?? controller.targetedURL().map { [$0] } ?? []
        guard !urls.isEmpty, urls.count <= 100 else { return }
        // The prompt does canonical/volume eligibility checks off Finder's menu callback.
        // Launch the embedded native prompt with the paths as arguments, never a shell, a temporary file or credentials.
        // The sandboxed extension cannot read the selection, so macOS refuses to open it as documents.
        let app = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
        let helper = app.appendingPathComponent("Resources/app/native/mac/build/DroidOfficeFinderBridge.app")
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = ["--dispatch"] + urls.map(\.path)
        // A running helper would ignore new arguments and swallow the dispatch.
        configuration.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: helper, configuration: configuration) { _, error in
            if error != nil {
                DispatchQueue.main.async {
                    let alert = NSAlert()
                    alert.messageText = "Droid Office's dispatch prompt could not open."
                    alert.informativeText = "Reopen the signed Droid Office app. Nothing was queued."
                    alert.runModal()
                }
            }
        }
    }
}
