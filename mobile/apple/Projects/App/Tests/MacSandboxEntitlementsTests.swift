import XCTest

/// The App Sandbox entitlements of the macOS app: every capability the app uses must be granted, since a sandboxed
/// process that lacks one fails at runtime and not at build time. Both apps also claim alldots.app for its
/// password-reset links, and nothing else.
final class MacSandboxEntitlementsTests: XCTestCase {

    // MARK: - Entitlements
    func testTheSandboxedMacAppMayOpenConnectionsToTheServer() throws {
        XCTAssertEqual(try entitlements()["com.apple.security.network.client"] as? Bool, true)
    }

    func testTheSandboxIsOnAndTheRecorderTheWakeGuardAndTheImportCanUseTheirResources() throws {
        let granted = try entitlements()
        XCTAssertEqual(granted["com.apple.security.app-sandbox"] as? Bool, true)
        XCTAssertEqual(granted["com.apple.security.device.audio-input"] as? Bool, true)
        XCTAssertEqual(granted["com.apple.security.device.camera"] as? Bool, true)
        XCTAssertEqual(granted["com.apple.security.files.user-selected.read-only"] as? Bool, true)
    }

    func testTheMacAndTheIOSAppClaimOnlyTheLinksOfAlldotsApp() throws {
        for file in ["Alldots.entitlements", "Alldots-iOS.entitlements"] {
            let domains = try entitlements(file)["com.apple.developer.associated-domains"] as? [String]
            XCTAssertEqual(domains, ["applinks:alldots.app"], file)
        }
    }
}

// MARK: - Helpers
private extension MacSandboxEntitlementsTests {

    func entitlements(_ name: String = "Alldots.entitlements") throws -> [String: Any] {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Entitlements/\(name)")
        let data = try Data(contentsOf: file)
        let plist = try PropertyListSerialization.propertyList(from: data, format: nil)
        return try XCTUnwrap(plist as? [String: Any])
    }
}
