import XCTest

@testable import CoreKit

/// The device name is read when the app starts, so it must come from the kernel and never from the network.
final class DeviceIdentityTests: XCTestCase {

    // MARK: - Tests
    func testTheDeviceNameIsNotEmptyAndFitsTheServersLimit() {
        let name = DeviceIdentity.deviceName()
        XCTAssertFalse(name.isEmpty)
        XCTAssertLessThanOrEqual(name.count, 100)
        XCTAssertEqual(name, name.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// A reverse DNS lookup, which `ProcessInfo.hostName` can start, blocks for 20 to 40 seconds on a bad network; a
    /// synchronous read of the kernel's values takes microseconds.
    func testTheDeviceNameIsReadSynchronouslyWithoutWaitingForTheNetwork() {
        let start = ContinuousClock.now
        for _ in 0..<100 { _ = DeviceIdentity.deviceName() }
        XCTAssertLessThan(ContinuousClock.now - start, .seconds(1))
    }

    func testTheWholeIdentityIsBuiltWithTheSameNameAndAStableInstallationId() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "DeviceIdentityTests-\(UUID().uuidString)"))
        let first = DeviceIdentity.current(defaults: defaults)
        let second = DeviceIdentity.current(defaults: defaults)
        XCTAssertEqual(first.deviceName, DeviceIdentity.deviceName())
        XCTAssertEqual(first.deviceId, second.deviceId)
    }
}
