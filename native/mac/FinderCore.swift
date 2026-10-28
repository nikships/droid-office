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
struct FinderModel: Decodable, Identifiable { let id: String; let label: String }
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
