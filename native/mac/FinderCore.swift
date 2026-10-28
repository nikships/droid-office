import Foundation
import Security
import LocalAuthentication
import Darwin

enum FinderFailure: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let text): return text }
    }
}

struct BridgeRecord: Codable {
    let token: String
    let url: String
    func validated() throws -> BridgeRecord {
        guard token.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              FinderPolicy.endpoint(url) != nil else {
            throw FinderFailure.message("The Finder connection is invalid. Open Droid Office.")
        }
        return self
    }
}

enum FinderPolicy {
    static let appID = "com.nikships.droid-office"
    static let dispatchScheme = "droid-office-finder"
    static let group = "group.com.nikships.droid-office"
    static let accessGroup = "NW6B3R27LQ." + group
    static var home: String {
        guard let entry = getpwuid(getuid()), let dir = entry.pointee.pw_dir else { return "/nonexistent" }
        return String(cString: dir)
    }

    static func endpoint(_ value: String) -> URL? {
        guard let url = URL(string: value), let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              c.scheme == "http", c.host == "127.0.0.1", let port = c.port, (1...65535).contains(port),
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil, c.path == "/",
              value == "http://127.0.0.1:\(port)/" else { return nil }
        return url
    }

    // URL events survive a sandboxed FinderSync launch; OpenConfiguration.arguments does not.
    static func dispatchURL(_ urls: [URL]) throws -> URL {
        guard !urls.isEmpty, urls.count <= 100, urls.allSatisfy(\.isFileURL) else {
            throw FinderFailure.message("Select between 1 and 100 local items.")
        }
        var components = URLComponents()
        components.scheme = dispatchScheme
        components.host = "dispatch"
        components.queryItems = urls.map { URLQueryItem(name: "path", value: $0.path) }
        guard let url = components.url else { throw FinderFailure.message("This selection cannot be opened.") }
        _ = try dispatchSelection(url)
        return url
    }

    static func dispatchSelection(_ url: URL) throws -> [URL] {
        guard url.absoluteString.utf8.count <= 512 * 1024,
              let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              c.scheme == dispatchScheme, c.host == "dispatch", c.path.isEmpty,
              c.user == nil, c.password == nil, c.port == nil, c.fragment == nil,
              let items = c.queryItems, !items.isEmpty, items.count <= 100 else {
            throw FinderFailure.message("Invalid Finder selection. Select the items again in Finder.")
        }
        return try items.map { item in
            guard item.name == "path", let path = item.value, path.utf8.count <= 4096,
                  !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
                  allowedPath(path, home: home) else {
                throw FinderFailure.message("This location cannot be dispatched.")
            }
            return URL(fileURLWithPath: path)
        }
    }

    static func allowedPath(_ path: String, home: String) -> Bool {
        guard path.hasPrefix("/"), path != "/", !path.contains("\0") else { return false }
        let excluded = ["/System", "/Library", "/Network", "/net", "/private", home + "/Library",
                        home + "/.Trash", "/.Trashes", "/Volumes/.timemachine"]
        guard !excluded.contains(where: { path == $0 || path.hasPrefix($0 + "/") }) else { return false }
        let components = path.split(separator: "/").map(String.init)
        return !components.contains(where: {
            [".Trash", ".Trashes", ".timemachine", ".MobileBackups", ".droid-office", "Backups.backupdb"].contains($0)
            || $0.hasPrefix("com.apple.TimeMachine.")
        })
    }

    static func paths(_ urls: [URL]) throws -> [String] {
        guard !urls.isEmpty, urls.count <= 100 else { throw FinderFailure.message("Select between 1 and 100 local items.") }
        return try urls.map { url in
            guard url.isFileURL, allowedPath(url.path, home: home) else { throw FinderFailure.message("This location cannot be dispatched.") }
            guard let resolved = realpath(url.path, nil) else { throw FinderFailure.message("This location is unavailable.") }
            defer { free(resolved) }
            let canonical = URL(fileURLWithPath: String(cString: resolved))
            guard allowedPath(canonical.path, home: home) else { throw FinderFailure.message("This location cannot be dispatched.") }
            let info = try canonical.resourceValues(forKeys: [.volumeIsLocalKey, .volumeIsReadOnlyKey, .volumeURLKey])
            guard info.volumeIsLocal == true, info.volumeIsReadOnly == false else {
                throw FinderFailure.message("Network and read-only volumes cannot be dispatched.")
            }
            if let volume = info.volume {
                let backupMarkers = [".com.apple.timemachine.supported", ".com.apple.timemachine.donotpresent", "Backups.backupdb"]
                guard !backupMarkers.contains(where: { FileManager.default.fileExists(atPath: volume.appendingPathComponent($0).path) }) else {
                    throw FinderFailure.message("Time Machine volumes cannot be dispatched.")
                }
            }
            return canonical.path
        }
    }
}

enum FinderKeychain {
    private static var query: [String: Any] {
        let context = LAContext()
        context.interactionNotAllowed = true
        return [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.nikships.droid-office.finder",
         kSecAttrAccount as String: "bridge-v1",
         kSecAttrAccessGroup as String: FinderPolicy.accessGroup,
         kSecUseDataProtectionKeychain as String: true,
         kSecUseAuthenticationContext as String: context]
    }

    static func requireEntitlements() throws {
        var code: SecCode?
        var staticCode: SecStaticCode?
        var info: CFDictionary?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code,
              SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
              SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let dictionary = info as? [String: Any],
              let entitlements = dictionary[kSecCodeInfoEntitlementsDict as String] as? [String: Any],
              (entitlements["keychain-access-groups"] as? [String])?.contains(FinderPolicy.accessGroup) == true,
              (entitlements["com.apple.security.application-groups"] as? [String])?.contains(FinderPolicy.group) == true,
              entitlements["com.apple.developer.team-identifier"] as? String == "NW6B3R27LQ",
              FileManager.default.fileExists(atPath: Bundle.main.bundleURL.appendingPathComponent("Contents/embedded.provisionprofile").path)
        else { throw FinderFailure.message("Finder integration requires the signed, provisioned Droid Office app.") }
    }

    static func read() throws -> BridgeRecord? {
        try requireEntitlements()
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw FinderFailure.message("The shared Finder Keychain is unavailable (\(status)).")
        }
        return try JSONDecoder().decode(BridgeRecord.self, from: data).validated()
    }

    static func publish(_ url: String, retryDuplicate: Bool = true) throws -> BridgeRecord {
        guard FinderPolicy.endpoint(url) != nil else { throw FinderFailure.message("Invalid loopback endpoint.") }
        if let previous = try read() {
            let record = BridgeRecord(token: previous.token, url: url)
            let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: try JSONEncoder().encode(record)] as CFDictionary)
            guard status == errSecSuccess else { throw FinderFailure.message("Cannot update Finder endpoint (\(status)).") }
            return record
        }
        var random = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, random.count, &random) == errSecSuccess else {
            throw FinderFailure.message("Cannot create Finder connection.")
        }
        let record = BridgeRecord(token: random.map { String(format: "%02x", $0) }.joined(), url: url)
        var item = query
        item[kSecValueData as String] = try JSONEncoder().encode(record)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        // Another app startup may have created it first. Never replace or rotate that token.
        if status == errSecDuplicateItem, retryDuplicate { return try publish(url, retryDuplicate: false) }
        guard status == errSecSuccess else { throw FinderFailure.message("Cannot save Finder connection (\(status)).") }
        return record
    }
}

final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class FinderAPI {
    private let record: BridgeRecord
    private let session: URLSession
    init() throws {
        guard let record = try FinderKeychain.read() else { throw FinderFailure.message("Open Droid Office to connect Finder.") }
        self.record = record
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForRequest = 8
        session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }

    func request<T: Decodable>(_ route: String, body: Data? = nil) async throws -> T {
        guard ["status", "resolve", "dispatch"].contains(route), let base = FinderPolicy.endpoint(record.url) else {
            throw FinderFailure.message("Invalid Finder request.")
        }
        var request = URLRequest(url: base.appendingPathComponent("api/finder/" + route))
        request.timeoutInterval = route == "status" ? 3 : 45
        request.httpMethod = body == nil ? "GET" : "POST"
        request.httpBody = body
        request.setValue(record.token, forHTTPHeaderField: "X-Droid-Office-Token")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, data.count <= 1_048_576 else {
            let message = (try? JSONDecoder().decode(APIError.self, from: data))?.error
            throw FinderFailure.message(message ?? "Droid Office is unavailable. Nothing was queued.")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

struct APIError: Decodable { let error: String }
struct APIStatus: Decodable { let ok: Bool }
struct ResolveRequest: Encodable { let paths: [String] }
struct FinderModel: Decodable, Identifiable {
    let id: String; let label: String; let provider: String?; let cost: Double?; let custom: Bool?; let legacy: Bool?
}
struct FinderGroup: Decodable, Identifiable {
    let floorId: String; let floorName: String; let repoRoot: String?
    let paths: [String]; let relativePaths: [String]; let isNewFloor: Bool; let model: String?
    var id: String { floorId }
}
struct ResolveResult: Decodable {
    let groups: [FinderGroup]; let models: [FinderModel]; let defaultModel: String?
}
struct DispatchRequest: Encodable { let paths: [String]; let prompt: String; let model: String; let requestId: String }
struct FinderDispatch: Decodable, Identifiable {
    let floorId: String; let leadId: String; let threadUrl: String; let deepLink: String
    var id: String { leadId }
}
struct DispatchError: Decodable { let floorId: String; let error: String }
struct DispatchResult: Decodable { let dispatches: [FinderDispatch]; let errors: [DispatchError] }

/// The same brand rules as src/client/ui/model-brand.ts; tests/finder-native.test.ts checks both give the same answers.
enum ModelBrands {
    /// Each brand's mark is `<brand>.png`, the Android app's Chromium render of the web SVG: CoreSVG drops Gemini's gradients and blurs Antigravity's filters.
    struct Mark { var mono = false; var tile = false }
    static let marks: [String: Mark] = [
        "claude": Mark(), "openai": Mark(mono: true), "codex": Mark(), "gemini": Mark(), "gemma": Mark(), "deepseek": Mark(), "qwen": Mark(),
        "grok": Mark(mono: true), "kimi": Mark(tile: true), "glm": Mark(), "minimax": Mark(), "mistral": Mark(), "meta": Mark(), "muse": Mark(),
        "junie": Mark(), "copilot": Mark(mono: true), "antigravity": Mark(), "openrouter": Mark(), "nvidia": Mark(), "cohere": Mark(), "perplexity": Mark(),
    ]
    private static let families: [(String, NSRegularExpression)] = [
        ("claude", #"\b(?:claude|opus|sonnet|haiku)\b"#), ("codex", #"\bcodex\b"#), ("gemini", #"\bgemini\b"#), ("gemma", #"\bgemma\b"#),
        ("deepseek", #"\bdeep[\s-]?seek\b"#), ("qwen", #"\bqwen(?:\d|\b)"#), ("grok", #"\bgrok\b"#), ("kimi", #"\bkimi\b"#),
        ("glm", #"\b(?:chat)?glm(?:\d|\b)"#), ("minimax", #"\bminimax\b"#), ("mistral", #"\b(?:mistral|mixtral|codestral|devstral|magistral)\b"#),
        ("muse", #"\bmuse\b"#), ("meta", #"\bllama(?:\d|\b)"#), ("cohere", #"\b(?:command(?:[ -][ar])?|aya)\b"#), ("nvidia", #"\bnemotron\b"#),
        ("perplexity", #"\bsonar\b"#), ("openai", #"\b(?:gpt(?:\d|\b)|chatgpt|o[1-9](?:\b|[ -]))"#),
    ].map { ($0.0, try! NSRegularExpression(pattern: $0.1, options: .caseInsensitive)) }
    private static let providers: [String: String] = [
        "anthropic": "claude", "claude": "claude", "openai": "openai", "chatgpt": "openai", "codex": "codex", "google": "gemini",
        "gemini": "gemini", "antigravity": "antigravity", "deepseek": "deepseek", "qwen": "qwen", "alibaba": "qwen", "xai": "grok",
        "grok": "grok", "moonshot": "kimi", "moonshotai": "kimi", "kimi": "kimi", "zai": "glm", "zhipu": "glm", "glm": "glm",
        "minimax": "minimax", "mistral": "mistral", "meta": "meta", "muse": "muse", "junie": "junie", "copilot": "copilot",
        "githubcopilot": "copilot", "openrouter": "openrouter", "nvidia": "nvidia", "cohere": "cohere", "perplexity": "perplexity",
    ]

    static func provider(_ provider: String?) -> String? {
        guard let key = provider?.lowercased().replacingOccurrences(of: "[^a-z0-9]", with: "", options: .regularExpression), !key.isEmpty else { return nil }
        return providers[key]
    }

    static func brand(id: String?, name: String?, provider: String?) -> String? {
        // IDs are canonical; a display name may mention a different family in a gateway or description.
        for text in [id, name].compactMap({ $0 }) where !text.isEmpty {
            let bare = text
                .replacingOccurrences(of: "^custom:(?:[^:]+:)?", with: "", options: [.regularExpression, .caseInsensitive])
                .replacingOccurrences(of: "^[^:]+:\\s*", with: "", options: .regularExpression)
                .replacingOccurrences(of: "_", with: "-")
            let range = NSRange(bare.startIndex..., in: bare)
            if let match = families.first(where: { $0.1.firstMatch(in: bare, range: range) != nil }) { return match.0 }
        }
        return self.provider(provider)
    }
}

/// One row of the model picker, named and grouped as src/client/ui/models.ts `pickerModel` does.
struct PickerEntry: Identifiable {
    let id: String
    let family: String?
    let name: String
    let group: String
    let yours: Bool
    let provider: String?
    let cost: Double?
    let brand: String?

    private static let providerLabels = ["anthropic": "Anthropic", "openai": "OpenAI", "google": "Google", "xai": "xAI", "factory": "Other"]

    init(_ model: FinderModel) {
        let provider = model.provider.map { Self.providerLabels[$0] ?? ($0.prefix(1).uppercased() + $0.dropFirst()) }
        let gateway = model.custom == true ? Self.gateway(model.id) : nil
        var name = model.label.replacingOccurrences(of: "\\s*\\[Deprecated\\]$", with: "", options: [.regularExpression, .caseInsensitive])
        if let gateway {
            name = name.replacingOccurrences(of: "^" + NSRegularExpression.escapedPattern(for: gateway) + "[\\w.-]*:\\s*", with: "", options: [.regularExpression, .caseInsensitive])
            if gateway == "DroidProxy" { name = name.replacingOccurrences(of: "droidproxy:?\\s*", with: "", options: [.regularExpression, .caseInsensitive]) }
        }
        let split = Self.splitFamily(name)
        id = model.id
        family = split.family
        self.name = split.rest
        group = gateway ?? (model.legacy == true ? "Legacy" : provider ?? "Other")
        yours = gateway != nil
        self.provider = provider
        cost = model.custom == true ? nil : model.cost
        brand = ModelBrands.brand(id: model.id, name: name, provider: provider)
    }

    var fullName: String { family.map { "\($0): \(name)" } ?? name }

    /// The gateway a BYOK model id goes through: "custom:droidproxy:gpt-6" is DroidProxy, "custom:openrouter:x" OpenRouter.
    static func gateway(_ id: String) -> String {
        guard let match = id.range(of: "^custom:[^:]+:", options: .regularExpression) else { return "Your models" }
        let segment = String(id[match].dropFirst("custom:".count).dropLast())
        if segment.range(of: "^droidproxy", options: [.regularExpression, .caseInsensitive]) != nil { return "DroidProxy" }
        if segment.caseInsensitiveCompare("openrouter") == .orderedSame { return "OpenRouter" }
        let base = segment.replacingOccurrences(of: "-\\d+$", with: "", options: .regularExpression)
        return base.prefix(1).uppercased() + base.dropFirst()
    }

    /// "Antigravity: Claude Opus 5.5" draws its family muted.
    static func splitFamily(_ name: String) -> (family: String?, rest: String) {
        guard let at = name.range(of: ": ") else { return (nil, name) }
        let offset = name.distance(from: name.startIndex, to: at.lowerBound)
        return offset > 0 && offset < 24 ? (String(name[..<at.lowerBound]), String(name[at.upperBound...])) : (nil, name)
    }

    /// A credit multiplier as droid's picker says it: ×0.06, ×1.6, ×4.
    static func multiplier(_ value: Double) -> String {
        var text = String(format: "%.3f", value)
        while text.hasSuffix("0") { text.removeLast() }
        if text.hasSuffix(".") { text.removeLast() }
        return "×" + text
    }

    private static func squash(_ text: String) -> String {
        String(String.UnicodeScalarView(text.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }))
    }

    /// The web picker's scoring (model-search.ts `scoreModel`): 0 when some word hits nothing; hits in the name beat the rest.
    func score(_ query: String) -> Int {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return 1 }
        let name = fullName.lowercased()
        let squashed = Self.squash(fullName)
        let elsewhere = "\(id) \(provider ?? "") \(group) \(yours ? "Yours" : group)".lowercased()
        var score = 0
        for word in words {
            let w = Self.squash(word)
            if let at = name.range(of: word) {
                let start = at.lowerBound == name.startIndex
                let before = start ? nil : name[name.index(before: at.lowerBound)]
                let afterBreak = before.map { !$0.isLetter && !$0.isNumber } ?? false
                score += 6 + (start ? 6 : afterBreak ? 4 : 0)
            } else if !w.isEmpty, squashed.contains(w) {
                score += 4
            } else if elsewhere.contains(word) {
                score += 2
            } else if !w.isEmpty, Self.squash(elsewhere).contains(w) {
                score += 1
            } else {
                return 0
            }
        }
        return score + (name == query.trimmingCharacters(in: .whitespaces).lowercased() ? 20 : 0)
    }

    struct Section { let label: String; let entries: [PickerEntry]; let flat: Bool }

    /// Sections in catalogue order, the owner's own gateways first with the biggest on top; a query gives one flat list, best first.
    static func sections(_ entries: [PickerEntry], query: String) -> [Section] {
        if !query.trimmingCharacters(in: .whitespaces).isEmpty {
            let scored: [(index: Int, entry: PickerEntry, score: Int)] = entries.enumerated().map { ($0.offset, $0.element, $0.element.score(query)) }
            let ranked = scored.filter { $0.score > 0 }.sorted { a, b in a.score != b.score ? a.score > b.score : a.index < b.index }
            let hits = ranked.map { $0.entry }
            return hits.isEmpty ? [] : [Section(label: "\(hits.count) \(hits.count == 1 ? "match" : "matches")", entries: hits, flat: true)]
        }
        var order: [String] = []
        var grouped: [String: [PickerEntry]] = [:]
        for entry in entries {
            if grouped[entry.group] == nil { order.append(entry.group) }
            grouped[entry.group, default: []].append(entry)
        }
        let yours = order.filter { grouped[$0]?.first?.yours == true }.sorted { grouped[$0]!.count > grouped[$1]!.count }
        return (yours + order.filter { grouped[$0]?.first?.yours != true }).map { Section(label: $0, entries: grouped[$0]!, flat: false) }
    }
}
