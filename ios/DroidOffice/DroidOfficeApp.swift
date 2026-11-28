import OfficeMobile
import SwiftUI

@main struct DroidOfficeApp: App {
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            OfficeController()
                .ignoresSafeArea()
                .preferredColorScheme(.dark)
                .onOpenURL { OfficePhone.shared.open(url: $0.absoluteString) }
                .onChange(of: phase, initial: true) { _, phase in
                    if phase != .inactive { OfficePhone.shared.foreground(shown: phase == .active) }
                }
        }
    }
}

private struct OfficeController: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController { OfficePhone.shared.viewController() }
    func updateUIViewController(_ controller: UIViewController, context: Context) {}
}
