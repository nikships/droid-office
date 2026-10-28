import AppKit
import FinderSync
import SwiftUI
import UserNotifications

@main
enum Bridge {
    @MainActor static func main() {
        do {
            let args = CommandLine.arguments
            if args.count == 3, args[1] == "--publish" {
                let record = try FinderKeychain.publish(args[2])
                FileHandle.standardOutput.write(try JSONEncoder().encode(record))
            } else if args.count == 2, args[1] == "--settings" {
                FIFinderSyncController.showExtensionManagementInterface()
                // The request is delivered over XPC on the main run loop. Exiting at once drops it and System Settings never opens.
                RunLoop.main.run(until: Date().addingTimeInterval(2))
            } else if args.count == 1 || args.dropFirst().allSatisfy({ $0.hasPrefix("-psn_") }) {
                run(PromptApplication(initial: []))
            } else if (3...101).contains(args.count), args[1] == "--dispatch", args.dropFirst(2).allSatisfy({ $0.hasPrefix("/") }) {
                run(PromptApplication(initial: args.dropFirst(2).map { URL(fileURLWithPath: $0) }))
            } else {
                throw FinderFailure.message("Expected --publish <loopback URL>, --settings or --dispatch <absolute paths>.")
            }
        } catch {
            // Never interpolate an encoded record, request or raw Keychain value here.
            FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
            exit(1)
        }
    }
    @MainActor private static func run(_ delegate: PromptApplication) {
        let application = NSApplication.shared
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}

@MainActor
final class PromptApplication: NSObject, NSApplicationDelegate {
    private var windows: [NSWindow] = []
    private let initial: [URL]
    init(initial: [URL]) {
        self.initial = initial
        super.init()
    }
    // Each dispatch is its own process, so a closed prompt must not leave an invisible helper behind.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = FinderNotifications.shared
        let main = NSMenu()
        let appItem = NSMenuItem()
        let applicationMenu = NSMenu()
        applicationMenu.addItem(withTitle: "Quit Dispatch Prompt", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = applicationMenu
        main.addItem(appItem)
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        editItem.submenu = edit
        main.addItem(editItem)
        NSApplication.shared.mainMenu = main
        if !initial.isEmpty { show(initial, in: NSApplication.shared) }
    }
    func application(_ application: NSApplication, open urls: [URL]) {
        show(urls, in: application)
    }
    private func show(_ urls: [URL], in application: NSApplication) {
        let model = DispatchPrompt(urls: urls)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 570, height: 540),
                              styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Dispatch to Office"
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: DispatchView(model: model, close: { [weak window] in window?.close() }))
        windows.removeAll { !$0.isVisible }
        windows.append(window)
        window.center()
        window.makeKeyAndOrderFront(nil)
        application.activate(ignoringOtherApps: true)
        Task { await model.resolve() }
    }
}
