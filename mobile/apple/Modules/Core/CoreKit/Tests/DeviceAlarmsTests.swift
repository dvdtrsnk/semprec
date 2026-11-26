import SharedSDK
import XCTest

#if os(iOS)
import AlarmKit
#endif

@testable import CoreKit

/// The Swift side of the shared `DeviceAlarms` and `SleepAlarmLedger` ports: the alarms of the system, the ledger in
/// the user defaults, and the Kotlin `SleepAlarmSync` running over a scripted device.
final class DeviceAlarmsTests: XCTestCase {

    // MARK: - Ledger
    @MainActor
    func testTheLedgerKeepsWhatItWasGivenAndForgetsWhenEmptied() throws {
        let defaults = try Self.isolatedDefaults()
        let ledger = DefaultsSleepAlarmLedger(defaults: defaults)
        XCTAssertEqual(ledger.load(), [:])

        ledger.save(entries: ["sleep:a": "id-1", "sleep:b": "id-2"])
        XCTAssertEqual(DefaultsSleepAlarmLedger(defaults: defaults).load(), ["sleep:a": "id-1", "sleep:b": "id-2"])

        ledger.save(entries: [:])
        XCTAssertEqual(ledger.load(), [:])
    }

    @MainActor
    func testAnEntryThatIsNotATextIsLeftOutOfTheLedger() throws {
        let defaults = try Self.isolatedDefaults()
        defaults.set(["sleep:a": "id-1", "sleep:b": 7], forKey: "cz.semprec.sleepAlarmLedger")
        XCTAssertEqual(DefaultsSleepAlarmLedger(defaults: defaults).load(), ["sleep:a": "id-1"])
    }

    // MARK: - The shared layer over a scripted device
    @MainActor
    func testTheSharedLayerRemovesTheAlarmsThroughTheDeviceAndKeepsALedgerOfWhatItRang() async throws {
        let device = ScriptedDevice(held: [("a1", .scheduled), ("a2", .alerting), ("stray", .scheduled)])
        let ledger = SharedSDK.InMemorySleepAlarmLedger()
        ledger.save(entries: ["sleep:a": "a1", "sleep:b": "a2"])
        let sdk = SharedSDK.DevicePushSDK(
            sessionStorage: SharedSDK.InMemorySessionStorage(),
            subscriptions: SharedSDK.InMemoryPushSubscriptionStorage(),
            alarms: device,
            sleepAlarmLedger: ledger,
            wakeStorage: SharedSDK.InMemoryWakeStorage()
        )

        let result = try await sdk.sleepAlarms.signedOut()

        XCTAssertEqual(result, .synced)
        XCTAssertEqual(device.cancelled, ["a1", "stray"], "the ringing alarm stays, on the main thread")
        XCTAssertTrue(ledger.load().isEmpty)
    }

    @MainActor
    func testADeviceThatIsUnsupportedIsLeftAlone() async throws {
        let device = ScriptedDevice(held: [("a1", .scheduled)])
        device.state = .unsupported
        let sdk = SharedSDK.DevicePushSDK(
            sessionStorage: SharedSDK.InMemorySessionStorage(),
            subscriptions: SharedSDK.InMemoryPushSubscriptionStorage(),
            alarms: device,
            sleepAlarmLedger: SharedSDK.InMemorySleepAlarmLedger(),
            wakeStorage: SharedSDK.InMemoryWakeStorage()
        )

        let result = try await sdk.sleepAlarms.sync()

        XCTAssertEqual(result, .unsupported)
        XCTAssertTrue(device.cancelled.isEmpty)
    }

    // MARK: - The system's alarms
    #if os(iOS)
    @MainActor
    func testEveryAuthorizationOfTheSystemMaps() {
        XCTAssertEqual(DeviceAlarmScheduler.authorization(.notDetermined), .notDetermined)
        XCTAssertEqual(DeviceAlarmScheduler.authorization(.denied), .denied)
        XCTAssertEqual(DeviceAlarmScheduler.authorization(.authorized), .authorized)
    }

    @MainActor
    func testOnlyAnAlarmThatRingsCannotBeRemoved() {
        XCTAssertEqual(DeviceAlarmScheduler.phase(.scheduled), .scheduled)
        XCTAssertEqual(DeviceAlarmScheduler.phase(.countdown), .scheduled)
        XCTAssertEqual(DeviceAlarmScheduler.phase(.paused), .scheduled)
        XCTAssertEqual(DeviceAlarmScheduler.phase(.alerting), .alerting)
    }

    @MainActor
    func testOnlyAnAlarmThatRingsIsStoppedAndEveryOtherIsCancelled() {
        XCTAssertEqual(DeviceAlarmScheduler.removal(.alerting), .stop)
        XCTAssertEqual(DeviceAlarmScheduler.removal(.scheduled), .cancel)
        XCTAssertEqual(DeviceAlarmScheduler.removal(.countdown), .cancel)
        XCTAssertEqual(DeviceAlarmScheduler.removal(.paused), .cancel)
    }

    @MainActor
    func testTheTwoAlertsDifferByTheSecondButton() {
        XCTAssertNil(DeviceAlarmScheduler.alert(opensWakeGuard: false).secondaryButton)
        XCTAssertNotNil(DeviceAlarmScheduler.alert(opensWakeGuard: true).secondaryButton)
        XCTAssertEqual(DeviceAlarmScheduler.alert(opensWakeGuard: true).secondaryButtonBehavior, .custom)
    }

    @MainActor
    func testTheLimitIsRefusedAndAnyOtherFailureIsNotExplained() {
        let limit = DeviceAlarmScheduler.failure(AlarmManager.AlarmError.maximumLimitReached)
        XCTAssertEqual((limit as? SharedSDK.DeviceAlarmSchedulingRefused)?.failure, .limitReached)
        let other = DeviceAlarmScheduler.failure(CocoaError(.fileNoSuchFile))
        XCTAssertTrue(other is SharedSDK.DeviceAlarmSchedulingFailed)
    }
    #else
    @MainActor
    func testMacOSHasNoAlarmsAndSchedulesNone() {
        let scheduler = DeviceAlarmScheduler()
        XCTAssertEqual(scheduler.authorization(), .unsupported)
        XCTAssertTrue(scheduler.cancel(id: UUID().uuidString))
        var held: [SharedSDK.HeldDeviceAlarm]?
        scheduler.held { held = $0 }
        XCTAssertEqual(held?.count, 0)
    }

    @MainActor
    func testMacOSRefusesToScheduleAnAlarmAsUnsupported() async throws {
        let scheduler = DeviceAlarmScheduler()
        var answer: SharedSDK.DeviceAlarmScheduling?
        scheduler.schedule(ringAtEpochSeconds: 1_800_000_000, opensWakeGuard: true) { answer = $0 }
        for _ in 0..<500 where answer == nil { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual((answer as? SharedSDK.DeviceAlarmSchedulingRefused)?.failure, .unsupported)
    }
    #endif
}

// MARK: - Helpers
private extension DeviceAlarmsTests {

    static func isolatedDefaults() throws -> UserDefaults {
        try XCTUnwrap(UserDefaults(suiteName: "cz.semprec.tests.\(UUID().uuidString)"))
    }
}

/// A device that holds the alarms it was given and records the ones removed.
@MainActor
private final class ScriptedDevice: NSObject {

    var state: SharedSDK.DeviceAlarmAuthorization = .authorized
    private let alarms: [(String, SharedSDK.DeviceAlarmPhase)]
    private(set) var cancelled: [String] = []

    init(held: [(String, SharedSDK.DeviceAlarmPhase)]) {
        alarms = held
    }
}

// MARK: - Protocol conformance
extension ScriptedDevice: @preconcurrency SharedSDK.DeviceAlarms {

    func authorization() -> SharedSDK.DeviceAlarmAuthorization { state }

    func schedule(
        ringAtEpochSeconds: Int64,
        opensWakeGuard: Bool,
        callback: @escaping (SharedSDK.DeviceAlarmScheduling) -> Void
    ) {
        callback(SharedSDK.DeviceAlarmSchedulingFailed.shared)
    }

    func cancel(id: String) -> Bool {
        cancelled.append(id)
        return true
    }

    func held(callback: @escaping ([SharedSDK.HeldDeviceAlarm]?) -> Void) {
        callback(alarms.map { SharedSDK.HeldDeviceAlarm(id: $0.0, phase: $0.1) })
    }
}
