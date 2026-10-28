import AppKit
import FinderSync

@objc(FinderSync)
final class FinderSync: FIFinderSync {
    private var online = false
    private var checked = Date.distantPast
    private var checking = false
    private weak var currentItem: NSMenuItem?

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
            if let item = self.currentItem {
                item.title = self.online ? "Dispatch to Office…" : "Open Droid Office"
                item.action = self.online ? #selector(self.dispatchSelection(_:)) : #selector(self.openOffice(_:))
            }
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
        currentItem = item
        item.representedObject = urls
        item.isEnabled = false
        menu.addItem(item)
        Task { @MainActor in
            let allowed = await Task.detached { (try? FinderPolicy.paths(urls)) != nil }.value
            if allowed { item.isEnabled = true }
            else { menu.removeItem(item) }
        }
        return menu
    }

    @objc private func openOffice(_ sender: Any?) {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: FinderPolicy.appID) else { return }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
    }

    @objc private func dispatchSelection(_ sender: NSMenuItem) {
        guard let urls = sender.representedObject as? [URL] else { return }
        // Launch the embedded native prompt with file URLs, never a shell, a temporary file or credentials.
        let app = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
        let helper = app.appendingPathComponent("Resources/app/native/mac/build/DroidOfficeFinderBridge.app")
        NSWorkspace.shared.open(urls, withApplicationAt: helper, configuration: NSWorkspace.OpenConfiguration()) { _, error in
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
