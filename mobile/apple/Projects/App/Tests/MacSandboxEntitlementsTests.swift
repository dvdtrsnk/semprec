import XCTest

/// The App Sandbox entitlements of the macOS app: every capability the app uses must be granted, since a sandboxed
/// process that lacks one fails at runtime and not at build time.
final class MacSandboxEntitlementsTests: XCTestCase {

    // MARK: - Entitlements
    func testTheSandboxedMacAppMayOpenConnectionsToTheServer() throws {
        XCTAssertEqual(try entitlements()["com.apple.security.network.client"] as? Bool, true)
    }

    func testTheSandboxIsOnAndTheRecorderAndTheImportCanUseTheirResources() throws {
        let granted = try entitlements()
        XCTAssertEqual(granted["com.apple.security.app-sandbox"] as? Bool, true)
        XCTAssertEqual(granted["com.apple.security.device.audio-input"] as? Bool, true)
        XCTAssertEqual(granted["com.apple.security.files.user-selected.read-only"] as? Bool, true)
    }
}

// MARK: - Helpers
private extension MacSandboxEntitlementsTests {

    func entitlements() throws -> [String: Any] {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Entitlements/Semprec.entitlements")
        let data = try Data(contentsOf: file)
        let plist = try PropertyListSerialization.propertyList(from: data, format: nil)
        return try XCTUnwrap(plist as? [String: Any])
    }
}
