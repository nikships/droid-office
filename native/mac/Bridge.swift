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
                let application = NSApplication.shared
                let delegate = PromptApplication()
                application.delegate = delegate
                withExtendedLifetime(delegate) { application.run() }
            } else {
                throw FinderFailure.message("Expected --publish <loopback URL> or --settings.")
            }
        } catch {
            // Never interpolate an encoded record, request or raw Keychain value here.
            FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
            exit(1)
        }
    }
}

@MainActor
final class PromptApplication: NSObject, NSApplicationDelegate {
    private var windows: [NSWindow] = []
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
    }
    func application(_ application: NSApplication, open urls: [URL]) {
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
