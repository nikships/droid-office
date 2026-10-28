import Foundation
import Security

@main
enum PolicyTests {
    static func main() throws {
        if CommandLine.arguments.dropFirst().first == "--models" {
            try printModels()
            return
        }
        if CommandLine.arguments.dropFirst().first == "--signing-info" {
            var staticCode: SecStaticCode?
            var info: CFDictionary?
            let binary = URL(fileURLWithPath: CommandLine.arguments[2])
            precondition(SecStaticCodeCreateWithPath(binary as CFURL, [], &staticCode) == errSecSuccess)
            precondition(SecCodeCopySigningInformation(staticCode!, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess)
            let values = info as! [String: Any]
            let entitlements = values[kSecCodeInfoEntitlementsDict as String] as! [String: Any]
            precondition(entitlements["office.test-marker"] as? Bool == true)
            print("Signing information exposes entitlements without requirement flags.")
            return
        }
        let home = "/Users/test-owner"
        for path in ["/", "/System", "/System/Volumes/Data/file", "/Library/a", home + "/Library/a",
                     home + "/.Trash/a", "/Volumes/Disk/.Trashes/501/file",
                     home + "/.droid-office/worktrees/a", "/Volumes/Disk/.MobileBackups/a",
                     "/Volumes/.timemachine/a", "/Volumes/Backup/Backups.backupdb/a",
                     "/Network/server/share", "/net/server/file", "relative", "/private/var/a"] {
            precondition(!FinderPolicy.allowedPath(path, home: home), path)
        }
        for path in [home + "/Code/a", home + "/Library-project", "/Volumes/Work/repo"] {
            precondition(FinderPolicy.allowedPath(path, home: home), path)
        }
        precondition(FinderPolicy.endpoint("http://127.0.0.1:4321/") != nil)
        for url in ["https://127.0.0.1:4321/", "http://localhost:4321/", "http://127.0.0.1:0/",
                    "http://127.0.0.1:65536/", "http://u:p@127.0.0.1:4321/", "http://127.0.0.1:4321/?a=b",
                    "http://127.0.0.1:4321/#x", "http://127.0.0.1:4321/api", "http://127.0.0.1:04321/"] {
            precondition(FinderPolicy.endpoint(url) == nil, url)
        }
        let record = BridgeRecord(token: String(repeating: "a", count: 64), url: "http://127.0.0.1:4321/")
        _ = try record.validated()
        do {
            _ = try BridgeRecord(token: "invalid", url: record.url).validated()
            preconditionFailure("accepted invalid token")
        } catch {}
        // This executable has no Keychain entitlements or profile. It must fail before any Keychain query.
        do {
            try FinderKeychain.requireEntitlements()
            preconditionFailure("accepted unprovisioned executable")
        } catch {}
        do {
            _ = try FinderPolicy.paths([])
            preconditionFailure("accepted empty selection")
        } catch {}
        for systemAlias in ["/etc", "/var", "/tmp"] {
            do {
                _ = try FinderPolicy.paths([URL(fileURLWithPath: systemAlias)])
                preconditionFailure("accepted system alias " + systemAlias)
            } catch {}
        }
        do {
            _ = try FinderPolicy.paths(Array(repeating: URL(fileURLWithPath: "/Users/test-owner/Code"), count: 101))
            preconditionFailure("accepted oversized selection")
        } catch {}
        print("Finder policy checks passed; no Keychain or Finder extension was accessed.")
    }

    /// Answers tests/finder-native.test.ts compares with the web picker: brands, rows, sections and cost labels.
    private struct ModelsInput: Decodable {
        struct Identity: Decodable { let id: String?; let name: String?; let provider: String? }
        let models: [FinderModel]; let identities: [Identity]; let queries: [String]; let multipliers: [Double]
    }

    private static func printModels() throws {
        let input = try JSONDecoder().decode(ModelsInput.self, from: FileHandle.standardInput.readDataToEndOfFile())
        let entries = input.models.map(PickerEntry.init)
        let none = NSNull()
        let output: [String: Any] = [
            "marks": ModelBrands.marks.mapValues { ["mono": $0.mono, "tile": $0.tile] },
            "brands": input.identities.map { ModelBrands.brand(id: $0.id, name: $0.name, provider: $0.provider) ?? none as Any },
            "entries": entries.map { ["id": $0.id, "name": $0.fullName, "group": $0.group, "cost": $0.cost ?? none as Any, "brand": $0.brand ?? none as Any] },
            "sections": input.queries.map { query in PickerEntry.sections(entries, query: query).map { ["label": $0.label, "ids": $0.entries.map(\.id)] } },
            "multipliers": input.multipliers.map(PickerEntry.multiplier),
        ]
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))
    }
}
