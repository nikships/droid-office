import AppKit
import SwiftUI
import UserNotifications

@MainActor
final class DispatchPrompt: ObservableObject {
    @Published var prompt = ""
    @Published var model = "floor-default"
    @Published var resolved: ResolveResult?
    @Published var entries: [PickerEntry] = []
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
            entries = value.models.map(PickerEntry.init)
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

// Factory design language: flat dark surfaces, 1px hairlines, 3px corners, uppercase monospaced chrome and one orange accent.
private enum Brand {
    static let base = Color(hex: 0x020202)
    static let surface = Color(hex: 0x0A0A0A)
    static let primary = Color(hex: 0xEEEEEE)
    static let secondary = Color(hex: 0x8C8C8C)
    static let tertiary = Color.white.opacity(0.32)
    static let hairline = Color.white.opacity(0.09)
    static let strong = Color.white.opacity(0.18)
    static let accent = Color(hex: 0xEE6018)
    static let danger = Color(hex: 0xEF4444)
    static let success = Color(hex: 0x3CCF91)
    static let warning = Color(hex: 0xF2B84B)
    static let radius: CGFloat = 3
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .system(size: size, weight: weight, design: .monospaced) }
}

private extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

private func chrome(_ text: String, size: CGFloat = 10, weight: Font.Weight = .semibold, tracking: CGFloat = 1.2) -> Text {
    Text(text.uppercased()).font(Brand.mono(size, weight)).tracking(tracking)
}

private struct Hairline: View {
    var body: some View { Rectangle().fill(Brand.hairline).frame(height: 1) }
}

private struct Keycap: View {
    let label: String
    var body: some View {
        Text(label).font(Brand.mono(10)).foregroundStyle(Brand.secondary)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .overlay(RoundedRectangle(cornerRadius: 2).stroke(Brand.strong, lineWidth: 1))
    }
}

@MainActor private enum ModelIcons {
    private static var cache: [String: NSImage] = [:]
    static func image(_ brand: String) -> NSImage? {
        if let image = cache[brand] { return image }
        guard let url = Bundle.main.url(forResource: brand, withExtension: "png", subdirectory: "ModelIcons"), let image = NSImage(contentsOf: url) else { return nil }
        cache[brand] = image
        return image
    }
}

/// The office picker's logo: the brand's own colors, white for one-color marks, on a white tile for marks that need one.
private struct ModelLogo: View {
    let brand: String?
    var size: CGFloat = 16
    var body: some View {
        if let brand, let mark = ModelBrands.marks[brand], let image = ModelIcons.image(brand) {
            // A tile mark's render already has its white square.
            Image(nsImage: image).renderingMode(mark.mono ? .template : .original).resizable().interpolation(.high)
                .aspectRatio(contentMode: .fit).foregroundStyle(Brand.primary)
                .clipShape(RoundedRectangle(cornerRadius: mark.tile ? 2 : 0))
                .frame(width: size, height: size)
        } else {
            Text("◇").font(.system(size: size * 0.7)).foregroundStyle(Brand.tertiary)
                .frame(width: size, height: size)
                .overlay(RoundedRectangle(cornerRadius: 2).stroke(Brand.strong, lineWidth: 1))
        }
    }
}

/// Credits per token against the base rate: green when cheap, amber when dear, as in the office.
private struct CostPill: View {
    let cost: Double?
    var body: some View {
        if let cost {
            let (fore, back): (Color, Color) = cost <= 0.3 ? (Brand.success, Brand.success.opacity(0.1))
                : cost >= 4 ? (Brand.warning, Brand.warning.opacity(0.1)) : (Brand.secondary, Color.white.opacity(0.05))
            Text(PickerEntry.multiplier(cost)).font(Brand.mono(10, .medium)).monospacedDigit().foregroundStyle(fore)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(back, in: RoundedRectangle(cornerRadius: 2))
                .help("Credits per token, against the base rate")
        }
    }
}

private func modelName(_ family: String?, _ name: String, selected: Bool = false) -> Text {
    let rest = Text(name).foregroundStyle(Brand.primary)
    let text = family.map { Text("\($0): ").foregroundStyle(Brand.secondary) + rest } ?? rest
    return text.font(.system(size: 13, weight: selected ? .medium : .regular))
}

/// What "Floor default" runs: the floor's remembered Finder pick, or the lead's current model.
struct FloorDefault {
    let note: String
    let brand: String?
}

/// The office's model picker in a popover: type to search, arrows move, Return picks, Esc closes.
private struct ModelList: View {
    static let floorDefault = "floor-default"
    let entries: [PickerEntry]
    let fallback: FloorDefault
    @Binding var selection: String
    let dismiss: () -> Void
    @State private var query = ""
    @State private var cursor: String?
    @FocusState private var searching: Bool

    private var trimmed: String { query.trimmingCharacters(in: .whitespaces).lowercased() }
    private var sections: [PickerEntry.Section] { PickerEntry.sections(entries, query: query) }
    private var showsDefault: Bool { trimmed.isEmpty || "floor default \(fallback.note)".lowercased().contains(trimmed) }
    private var keys: [String] { (showsDefault ? [Self.floorDefault] : []) + sections.flatMap { $0.entries.map(\.id) } }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(Brand.secondary)
                TextField("", text: $query, prompt: Text("Search models or providers").foregroundStyle(Brand.tertiary))
                    .textFieldStyle(.plain).font(.system(size: 13)).foregroundStyle(Brand.primary)
                    .focused($searching)
                    .onSubmit { if let cursor { pick(cursor) } }
                    .onKeyPress(.downArrow) { move(1); return .handled }
                    .onKeyPress(.upArrow) { move(-1); return .handled }
                    .onKeyPress(.escape) { dismiss(); return .handled }
                Keycap(label: "esc")
            }.padding(.horizontal, 12).frame(height: 40)
            Hairline()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                        if showsDefault {
                            row(Self.floorDefault) {
                                ModelLogo(brand: fallback.brand)
                                Text("Floor default").font(.system(size: 13, weight: selection == Self.floorDefault ? .medium : .regular)).foregroundStyle(Brand.primary)
                                Text(fallback.note).font(.system(size: 12)).foregroundStyle(Brand.secondary).lineLimit(1)
                                Spacer(minLength: 6)
                            }
                        }
                        ForEach(sections, id: \.label) { section in
                            Section {
                                ForEach(section.entries) { entry in
                                    row(entry.id) {
                                        ModelLogo(brand: entry.brand)
                                        modelName(entry.family, entry.name, selected: entry.id == selection).lineLimit(1).truncationMode(.tail)
                                        Spacer(minLength: 6)
                                        if section.flat { Text(entry.group).font(.system(size: 11)).foregroundStyle(Brand.tertiary).lineLimit(1) }
                                        CostPill(cost: entry.cost)
                                    }
                                }
                            } header: {
                                HStack(spacing: 6) {
                                    if !section.flat, let brand = ModelBrands.provider(section.label) { ModelLogo(brand: brand, size: 12) }
                                    chrome(section.label, size: 9.5, weight: .medium, tracking: 1).foregroundStyle(Brand.secondary)
                                    Spacer()
                                    if !section.flat { Text("\(section.entries.count)").font(Brand.mono(9.5)).foregroundStyle(Brand.tertiary) }
                                }
                                .padding(.horizontal, 8).padding(.top, 10).padding(.bottom, 4)
                                .background(Brand.surface)
                            }
                        }
                        if keys.isEmpty {
                            Text("No models match “\(query)”.").font(.system(size: 12)).foregroundStyle(Brand.secondary).padding(12)
                        }
                    }.padding(.horizontal, 4).padding(.bottom, 4)
                }
                .onChange(of: cursor) { _, key in if let key { proxy.scrollTo(key) } }
            }
            Hairline()
            HStack(spacing: 8) {
                Text(cursor == Self.floorDefault ? "Floor's remembered Finder model" : cursor ?? "")
                    .font(Brand.mono(10.5)).foregroundStyle(Brand.tertiary).lineLimit(1).truncationMode(.middle)
                Spacer()
                Keycap(label: "↑↓")
                Keycap(label: "↩")
            }.padding(.horizontal, 12).frame(height: 30)
        }
        .frame(width: 440, height: 420)
        .background(Brand.surface)
        .environment(\.colorScheme, .dark)
        .onAppear {
            cursor = keys.contains(selection) ? selection : keys.first
            searching = true
        }
        .onChange(of: query) { cursor = keys.first }
    }

    private func row<Content: View>(_ key: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: 8) {
            Text(selection == key ? "✓" : "").font(.system(size: 11, weight: .semibold)).foregroundStyle(Brand.accent).frame(width: 12)
            content()
        }
        .padding(.horizontal, 8).frame(height: 30).frame(maxWidth: .infinity, alignment: .leading)
        .background(cursor == key ? Color.white.opacity(0.06) : Color.clear, in: RoundedRectangle(cornerRadius: Brand.radius))
        .contentShape(Rectangle())
        .onTapGesture { pick(key) }
        .onHover { if $0 { cursor = key } }
        .id(key)
    }

    private func move(_ by: Int) {
        let all = keys
        guard !all.isEmpty else { return }
        let at = cursor.flatMap { all.firstIndex(of: $0) } ?? -by
        cursor = all[(at + by + all.count) % all.count]
    }

    private func pick(_ key: String) {
        selection = key
        dismiss()
    }
}

private struct Eyebrow: View {
    let index: String
    let label: String
    var body: some View {
        HStack(spacing: 8) {
            chrome(index).foregroundStyle(Brand.accent)
            chrome(label).foregroundStyle(Brand.secondary)
        }
    }
}

private struct FactoryButton: ButtonStyle {
    let primary: Bool
    func makeBody(configuration: Configuration) -> some View {
        FactoryButtonBody(configuration: configuration, primary: primary)
    }
}

private struct FactoryButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let primary: Bool
    @Environment(\.isEnabled) private var enabled
    @State private var hover = false
    private var live: Bool { enabled && hover }
    var body: some View {
        configuration.label
            .font(Brand.mono(11, .semibold)).tracking(1.2).textCase(.uppercase)
            .foregroundStyle(foreground)
            .padding(.horizontal, 14).frame(height: 30)
            .background(background)
            .overlay(RoundedRectangle(cornerRadius: Brand.radius).stroke(border, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: Brand.radius))
            .opacity(configuration.isPressed ? 0.8 : 1)
            .contentShape(Rectangle())
            .onHover { hover = $0 }
            .animation(.easeOut(duration: 0.15), value: hover)
    }
    private var foreground: Color {
        guard enabled else { return Brand.tertiary }
        if primary { return Brand.base }
        return live ? Brand.accent : Brand.primary
    }
    private var background: Color {
        if primary { return enabled ? Brand.primary : Color.white.opacity(0.06) }
        return Brand.surface
    }
    private var border: Color {
        guard enabled else { return Brand.hairline }
        return live ? Brand.accent : (primary ? Brand.primary : Brand.strong)
    }
}

struct DispatchView: View {
    @ObservedObject var model: DispatchPrompt
    let close: () -> Void
    @FocusState private var editing: Bool
    @State private var picking = false

    var body: some View {
        VStack(spacing: 0) {
            header
            Hairline()
            VStack(alignment: .leading, spacing: 22) {
                if let resolved = model.resolved {
                    target(resolved)
                    task
                    modelPicker(resolved)
                }
                status
            }.padding(20).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            Hairline()
            footer
        }
        .frame(minWidth: 520, minHeight: 480)
        .background(Brand.base)
        .tint(Brand.accent)
        .environment(\.colorScheme, .dark)
        .ignoresSafeArea()
    }

    // The window draws under its title bar, so the traffic lights sit in this band.
    private var header: some View {
        HStack {
            chrome("Dispatch to Office", size: 11, tracking: 1.6).foregroundStyle(Brand.primary)
            Spacer()
        }.padding(.leading, 56).padding(.trailing, 20).frame(height: 44)
    }

    private func target(_ resolved: ResolveResult) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow(index: "01", label: "Target")
            // A short selection sits inline; only a long one scrolls, so the list never collapses or leaves a gap.
            let lines = resolved.groups.reduce(0) { $0 + 1 + $1.relativePaths.count }
            if lines > 5 {
                ScrollView { targetList(resolved) }.frame(height: 110)
            } else {
                targetList(resolved)
            }
        }
    }

    private func targetList(_ resolved: ResolveResult) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(resolved.groups) { group in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(group.floorName).font(.system(size: 13, weight: .semibold)).foregroundStyle(Brand.primary)
                        if group.isNewFloor {
                            chrome("New floor", size: 9, tracking: 1).foregroundStyle(Brand.secondary)
                                .padding(.horizontal, 5).padding(.vertical, 2)
                                .overlay(RoundedRectangle(cornerRadius: Brand.radius).stroke(Brand.strong, lineWidth: 1))
                        }
                    }
                    ForEach(Array(group.relativePaths.enumerated()), id: \.offset) { _, path in
                        Text(path).font(Brand.mono(11)).foregroundStyle(Brand.secondary).textSelection(.enabled).lineLimit(1).truncationMode(.middle)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var task: some View {
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow(index: "02", label: "Task")
            ZStack(alignment: .topLeading) {
                TextEditor(text: $model.prompt)
                    .font(.system(size: 13)).foregroundStyle(Brand.primary)
                    .scrollContentBackground(.hidden)
                    .focused($editing)
                    .disabled(model.attempted)
                    .padding(8)
                if model.prompt.isEmpty {
                    chrome("Describe the task", size: 11, weight: .regular, tracking: 1).foregroundStyle(Brand.tertiary)
                        .padding(.horizontal, 13).padding(.vertical, 12).allowsHitTesting(false)
                }
            }
            .frame(minHeight: 110, maxHeight: .infinity)
            .background(Brand.surface)
            .overlay(RoundedRectangle(cornerRadius: Brand.radius).stroke(editing ? Brand.accent : Brand.strong, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: Brand.radius))
            .animation(.easeOut(duration: 0.15), value: editing)
            HStack {
                Spacer()
                chrome("\(model.prompt.utf16.count) / 16000", size: 10, weight: .regular, tracking: 0.8)
                    .foregroundStyle(model.prompt.utf16.count > 16000 ? Brand.danger : Brand.tertiary)
            }
        }
    }

    private func modelPicker(_ resolved: ResolveResult) -> some View {
        let fallback = floorDefault(resolved)
        let entry = model.entries.first { $0.id == model.model }
        return VStack(alignment: .leading, spacing: 10) {
            Eyebrow(index: "03", label: "Model")
            Button { picking.toggle() } label: {
                HStack(spacing: 8) {
                    if let entry {
                        ModelLogo(brand: entry.brand)
                        modelName(entry.family, entry.name).lineLimit(1).truncationMode(.tail)
                    } else {
                        ModelLogo(brand: fallback.brand)
                        Text("Floor default").font(.system(size: 13)).foregroundStyle(Brand.primary)
                        Text(fallback.note).font(.system(size: 12)).foregroundStyle(Brand.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 6)
                    CostPill(cost: entry?.cost)
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .medium)).foregroundStyle(Brand.secondary)
                }
                .padding(.horizontal, 10).frame(height: 32)
                .background(Brand.surface)
                .overlay(RoundedRectangle(cornerRadius: Brand.radius).stroke(picking ? Brand.accent : Brand.strong, lineWidth: 1))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(model.attempted)
            .popover(isPresented: $picking, arrowEdge: .bottom) {
                ModelList(entries: model.entries, fallback: fallback, selection: $model.model, dismiss: { picking = false })
            }
        }
    }

    private func floorDefault(_ resolved: ResolveResult) -> FloorDefault {
        let remembered = Set(resolved.groups.compactMap(\.model))
        if remembered.count > 1 { return FloorDefault(note: "Remembered per floor", brand: nil) }
        guard let id = remembered.first else { return FloorDefault(note: "Lead's current model", brand: nil) }
        // A remembered pick hidden in Settings since is not listed, but it still names what runs.
        if let entry = model.entries.first(where: { $0.id == id }) { return FloorDefault(note: entry.fullName, brand: entry.brand) }
        return FloorDefault(note: id, brand: ModelBrands.brand(id: id, name: nil, provider: nil))
    }

    @ViewBuilder private var status: some View {
        if model.busy {
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                chrome(model.attempted ? "Dispatching…" : "Resolving selected items…", tracking: 1).foregroundStyle(Brand.secondary)
            }
        }
        if let error = model.error {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                chrome("Err").foregroundStyle(Brand.danger)
                Text(error).font(.system(size: 12)).foregroundStyle(Brand.primary).textSelection(.enabled)
            }
            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: Brand.radius).stroke(Brand.hairline, lineWidth: 1))
        }
        if model.notificationUnavailable {
            chrome("Dispatched. Notifications are unavailable; use Open Thread below.", size: 10, weight: .regular, tracking: 0.8)
                .foregroundStyle(Brand.secondary)
        }
        if let result = model.result {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(result.dispatches) { dispatch in
                    Button("Open Thread · \(dispatch.floorId) →") { model.openThread(dispatch) }.buttonStyle(FactoryButton(primary: false))
                }
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Spacer()
            Button(model.attempted ? "Close" : "Cancel", action: close)
                .buttonStyle(FactoryButton(primary: false)).keyboardShortcut(.cancelAction)
            if !model.attempted {
                // The shortcut hint stays outside the uppercase label so the symbols are not transformed.
                Text("⌘↩").font(Brand.mono(12)).foregroundStyle(Brand.secondary)
                Button("Dispatch →") {
                    Task {
                        await model.dispatch()
                        if model.canClose { close() }
                    }
                }
                .buttonStyle(FactoryButton(primary: true)).keyboardShortcut(.return, modifiers: .command).disabled(!model.valid)
            }
        }.padding(.horizontal, 20).frame(height: 56)
    }
}
