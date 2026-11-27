import SharedSDK
import XCTest

@testable import CoreKit

/// The debug alarm bridge: every Kotlin value and every Swift action it maps, and the real Kotlin ViewModel behind it
/// over a device that holds the alarms it was given. Both modules declare the type names, so each is qualified.
final class SharedDebugAlarmTests: XCTestCase {

    // MARK: - Mapping
    @MainActor
    func testTheStateMapsEveryField() {
        let state = SharedDebugAlarmScreenModel.state(SharedSDK.DebugAlarmState(
            authorization: .notDetermined,
            alarms: [
                SharedSDK.DebugAlarmRow(
                    id: "a1",
                    kind: .mission,
                    source: .sleepPlan,
                    ringAtEpochSeconds: KotlinLong(value: 1_800_000_000),
                    phase: .alerting,
                    codeCount: 2,
                    watchCount: 48
                )
            ],
            codeCount: 3,
            dailyDays: 7,
            busy: true,
            failure: .noCodes
        ))

        XCTAssertEqual(state, DebugAlarmState(
            authorization: .notDetermined,
            alarms: [
                DebugAlarmRow(
                    id: "a1",
                    kind: .mission,
                    source: .sleepPlan,
                    ringAt: Date(timeIntervalSince1970: 1_800_000_000),
                    phase: .alerting,
                    codeCount: 2,
                    watchCount: 48
                )
            ],
            codeCount: 3,
            dailyDays: 7,
            busy: true,
            failure: .noCodes
        ))
    }

    @MainActor
    func testARowWithoutAMomentOrAPhaseKeepsThemEmpty() {
        let row = SharedDebugAlarmScreenModel.row(SharedSDK.DebugAlarmRow(
            id: "a2", kind: .alarm, source: .unknown, ringAtEpochSeconds: nil, phase: nil, codeCount: 0, watchCount: 0
        ))

        XCTAssertNil(row.ringAt)
        XCTAssertNil(row.phase)
        XCTAssertEqual(row.source, .unknown)
        XCTAssertEqual(row.kind, .alarm)
    }

    @MainActor
    func testEveryAuthorizationPhaseKindAndSourceMaps() {
        XCTAssertEqual(SharedDebugAlarmScreenModel.authorization(.notDetermined), .notDetermined)
        XCTAssertEqual(SharedDebugAlarmScreenModel.authorization(.denied), .denied)
        XCTAssertEqual(SharedDebugAlarmScreenModel.authorization(.authorized), .authorized)
        XCTAssertEqual(SharedDebugAlarmScreenModel.authorization(.unsupported), .unsupported)
        XCTAssertEqual(SharedDebugAlarmScreenModel.phase(.scheduled), .scheduled)
        XCTAssertEqual(SharedDebugAlarmScreenModel.phase(.alerting), .alerting)
        XCTAssertEqual(SharedDebugAlarmScreenModel.kind(.alarm), .alarm)
        XCTAssertEqual(SharedDebugAlarmScreenModel.kind(.mission), .mission)
        XCTAssertEqual(SharedDebugAlarmScreenModel.source(.sleepPlan), .sleepPlan)
        XCTAssertEqual(SharedDebugAlarmScreenModel.source(.debug), .debug)
        XCTAssertEqual(SharedDebugAlarmScreenModel.source(.unknown), .unknown)
    }

    @MainActor
    func testEveryFailureMaps() {
        XCTAssertEqual(SharedDebugAlarmScreenModel.failure(.notAuthorized), .notAuthorized)
        XCTAssertEqual(SharedDebugAlarmScreenModel.failure(.limitReached), .limitReached)
        XCTAssertEqual(SharedDebugAlarmScreenModel.failure(.unsupported), .unsupported)
        XCTAssertEqual(SharedDebugAlarmScreenModel.failure(.deviceFailed), .deviceFailed)
        XCTAssertEqual(SharedDebugAlarmScreenModel.failure(.readFailed), .readFailed)
        XCTAssertEqual(SharedDebugAlarmScreenModel.failure(.noCodes), .noCodes)
        XCTAssertEqual(SharedDebugAlarmScreenModel.failure(.inThePast), .inThePast)
        XCTAssertEqual(SharedDebugAlarmScreenModel.failure(.invalidTime), .invalidTime)
    }

    @MainActor
    func testEveryDelayAndRepeatMaps() {
        XCTAssertEqual(SharedDebugAlarmScreenModel.delay(.tenSeconds), .tenSeconds)
        XCTAssertEqual(SharedDebugAlarmScreenModel.delay(.oneMinute), .oneMinute)
        XCTAssertEqual(SharedDebugAlarmScreenModel.delay(.fiveMinutes), .fiveMinutes)
        XCTAssertEqual(SharedDebugAlarmScreenModel.repeat(.once), .once)
        XCTAssertEqual(SharedDebugAlarmScreenModel.repeat(.daily), .daily)
    }

    @MainActor
    func testEveryActionMapsToItsKotlinAction() throws {
        let map = SharedDebugAlarmScreenModel.action
        XCTAssertEqual(map(.refresh) as? NSObject, SharedSDK.DebugAlarmActionRefresh.shared)
        XCTAssertEqual(map(.requestAuthorization) as? NSObject, SharedSDK.DebugAlarmActionRequestAuthorization.shared)
        XCTAssertEqual(map(.cancelAll) as? NSObject, SharedSDK.DebugAlarmActionCancelAll.shared)
        XCTAssertEqual(map(.dismissFailure) as? NSObject, SharedSDK.DebugAlarmActionDismissFailure.shared)
        let ringIn = try XCTUnwrap(map(.ringIn(.oneMinute, withCodes: true)) as? SharedSDK.DebugAlarmActionRingIn)
        XCTAssertEqual(ringIn.delay, .oneMinute)
        XCTAssertTrue(ringIn.withCodes)
        let ringAt = try XCTUnwrap(
            map(.ringAt(Date(timeIntervalSince1970: 1_800_000_000.9), repeat: .daily, withCodes: false))
                as? SharedSDK.DebugAlarmActionRingAt
        )
        XCTAssertEqual(ringAt.epochSeconds, 1_800_000_000)
        XCTAssertEqual(ringAt.repeat, .daily)
        XCTAssertFalse(ringAt.withCodes)
        let cancel = try XCTUnwrap(map(.cancel("a1")) as? SharedSDK.DebugAlarmActionCancel)
        XCTAssertEqual(cancel.id, "a1")
    }

    // MARK: - The Kotlin ViewModel
    @MainActor
    func testReleasingTheBridgeClosesTheKotlinViewModel() throws {
        var model: SharedDebugAlarmScreenModel? = try XCTUnwrap(
            isolatedFactory().makeDebugAlarms() as? SharedDebugAlarmScreenModel
        )
        let viewModel = try XCTUnwrap(model?.viewModel)
        XCTAssertFalse(viewModel.isClosed)

        model = nil

        XCTAssertTrue(viewModel.isClosed)
    }

    @MainActor
    func testADeviceWithoutAlarmsRefusesEveryRingAsUnsupported() async throws {
        let model = try XCTUnwrap(isolatedFactory().makeDebugAlarms() as? SharedDebugAlarmScreenModel)
        XCTAssertEqual(model.state.authorization, .unsupported)

        model.send(.ringIn(.tenSeconds, withCodes: false))
        let refused = await Self.firstState(of: model) { $0.failure != nil }

        XCTAssertEqual(refused?.failure, .unsupported)
        model.send(.dismissFailure)
        let dismissed = await Self.firstState(of: model) { $0.failure == nil }
        XCTAssertNil(dismissed?.failure)
    }

    @MainActor
    func testATestAlarmAndAMissionRingThroughTheDeviceAndCanBeRemoved() async throws {
        let device = HeldAlarmsDevice()
        let defaults = try Self.isolatedDefaults()
        DefaultsWakeStorage(defaults: defaults).saveSettings(
            settings: SharedSDK.WakeSettings(requiresCode: false, codes: ["123"])
        )
        let model = Self.model(device: device, defaults: defaults)

        model.send(.ringIn(.fiveMinutes, withCodes: false))
        let alarm = await Self.firstState(of: model) { $0.alarms.count == 1 && !$0.busy }
        let ringAt = try XCTUnwrap(alarm?.alarms.first?.ringAt)
        XCTAssertEqual(ringAt.timeIntervalSinceNow, 300, accuracy: 30)
        XCTAssertEqual(alarm?.alarms.first?.kind, .alarm)
        XCTAssertEqual(alarm?.alarms.first?.source, .debug)
        XCTAssertEqual(alarm?.codeCount, 1)
        XCTAssertEqual(device.opensWakeGuard, [false])

        model.send(.ringIn(.oneMinute, withCodes: true))
        let both = await Self.firstState(of: model) { $0.alarms.count == 2 && !$0.busy }
        XCTAssertEqual(both?.alarms.first?.kind, .mission, "the soonest first")
        XCTAssertEqual(both?.alarms.first?.codeCount, 1)
        XCTAssertGreaterThan(both?.alarms.first?.watchCount ?? 0, 0)

        model.send(.cancelAll)
        let none = await Self.firstState(of: model) { $0.alarms.isEmpty && !$0.busy }
        XCTAssertEqual(none?.alarms.count, 0)
        XCTAssertNil(none?.failure)
        XCTAssertTrue(device.alarms.isEmpty)
    }
}

// MARK: - Helpers
private extension SharedDebugAlarmTests {

    static func isolatedDefaults() throws -> UserDefaults {
        try XCTUnwrap(UserDefaults(suiteName: "cz.semprec.tests.\(UUID().uuidString)"))
    }

    /// The bridge of a Kotlin ViewModel over `device` and the wake storage in `defaults`.
    @MainActor
    static func model(device: HeldAlarmsDevice, defaults: UserDefaults) -> SharedDebugAlarmScreenModel {
        let push = SharedSDK.DevicePushSDK(
            sessionStorage: SharedSDK.InMemorySessionStorage(),
            subscriptions: SharedSDK.InMemoryPushSubscriptionStorage(),
            alarms: device,
            sleepAlarmLedger: SharedSDK.InMemorySleepAlarmLedger(),
            wakeStorage: DefaultsWakeStorage(defaults: defaults)
        )
        let home = SharedSDK.HomeSDK(
            sessionStorage: SharedSDK.InMemorySessionStorage(),
            device: DeviceIdentity.current(),
            recorder: SharedSDK.UnavailableAudioRecorder(),
            player: SharedSDK.UnavailableAudioPlayer(),
            pushSubscriptions: SharedSDK.InMemoryPushSubscriptionStorage(),
            cacheDirectory: nil,
            dataDirectory: nil,
            wake: push.wake,
            sleepAlarms: push.sleepAlarms,
            debugAlarms: push.debugAlarms
        )
        return SharedDebugAlarmScreenModel(home.debugAlarmViewModel())
    }

    /// The first state of `model` that matches `predicate`, or `nil` when none arrives within five seconds.
    @MainActor
    static func firstState<Model: ScreenModel>(
        of model: Model,
        where predicate: @escaping @Sendable (Model.State) -> Bool
    ) async -> Model.State? {
        let found = Found<Model.State>()
        let matched = XCTestExpectation(description: "A matching state arrived")
        let observer = Task { @MainActor in
            for await state in model.states() where predicate(state) {
                found.value = state
                matched.fulfill()
                return
            }
        }
        _ = await XCTWaiter.fulfillment(of: [matched], timeout: 5)
        observer.cancel()
        return found.value
    }
}

@MainActor
private final class Found<Value> {

    var value: Value?
}

/// A device that allows alarms and holds the ones it rang until they are removed.
@MainActor
private final class HeldAlarmsDevice: NSObject {

    private(set) var alarms: [String: SharedSDK.DeviceAlarmPhase] = [:]
    private(set) var opensWakeGuard: [Bool] = []
    private var next = 0
}

// MARK: - Protocol conformance
extension HeldAlarmsDevice: @preconcurrency SharedSDK.DeviceAlarms {

    func authorization() -> SharedSDK.DeviceAlarmAuthorization { .authorized }

    func requestAuthorization(callback: @escaping (SharedSDK.DeviceAlarmAuthorization) -> Void) {
        callback(.authorized)
    }

    func schedule(
        ringAtEpochSeconds: Int64,
        opensWakeGuard: Bool,
        callback: @escaping (SharedSDK.DeviceAlarmScheduling) -> Void
    ) {
        next += 1
        self.opensWakeGuard.append(opensWakeGuard)
        alarms["alarm-\(next)"] = .scheduled
        callback(SharedSDK.DeviceAlarmSchedulingScheduled(id: "alarm-\(next)"))
    }

    func cancel(id: String) -> Bool {
        alarms[id] = nil
        return true
    }

    func held(callback: @escaping ([SharedSDK.HeldDeviceAlarm]?) -> Void) {
        callback(alarms.map { SharedSDK.HeldDeviceAlarm(id: $0.key, phase: $0.value) })
    }
}
