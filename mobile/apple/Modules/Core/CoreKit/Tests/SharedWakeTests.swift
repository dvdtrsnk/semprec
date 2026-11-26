import SharedSDK
import XCTest

@testable import CoreKit

/// The wake bridges: every Kotlin value and every Swift action they map, the real Kotlin ViewModels behind them, and
/// the wake storage of the device. Both modules declare the type names, so each is qualified with its module.
final class SharedWakeTests: XCTestCase {

    // MARK: - Wake settings mapping
    @MainActor
    func testTheWakeSettingsStateMapsEveryField() {
        let state = SharedWakeSettingsScreenModel.state(SharedSDK.WakeSettingsState(
            requiresCode: true,
            codes: ["123", "456"],
            mode: .needsCode,
            failure: .limitReached
        ))

        XCTAssertEqual(
            state,
            WakeSettingsState(requiresCode: true, codes: ["123", "456"], mode: .needsCode, failure: .limitReached)
        )
        XCTAssertNil(SharedWakeSettingsScreenModel.state(SharedSDK.WakeSettingsState(
            requiresCode: false, codes: [], mode: .off, failure: nil
        )).failure)
    }

    @MainActor
    func testEveryWakeModeMaps() {
        XCTAssertEqual(SharedWakeSettingsScreenModel.mode(.off), .off)
        XCTAssertEqual(SharedWakeSettingsScreenModel.mode(.needsCode), .needsCode)
        XCTAssertEqual(SharedWakeSettingsScreenModel.mode(.active), .active)
    }

    @MainActor
    func testEveryWakeSettingsFailureMaps() {
        XCTAssertEqual(SharedWakeSettingsScreenModel.failure(.emptyCode), .emptyCode)
        XCTAssertEqual(SharedWakeSettingsScreenModel.failure(.notAuthorized), .notAuthorized)
        XCTAssertEqual(SharedWakeSettingsScreenModel.failure(.limitReached), .limitReached)
        XCTAssertEqual(SharedWakeSettingsScreenModel.failure(.readFailed), .readFailed)
        XCTAssertEqual(SharedWakeSettingsScreenModel.failure(.deviceFailed), .deviceFailed)
    }

    @MainActor
    func testEveryWakeSettingsActionMapsToItsKotlinAction() throws {
        let required = try XCTUnwrap(
            SharedWakeSettingsScreenModel.action(.setRequiresCode(true)) as? SharedSDK.WakeSettingsActionSetRequiresCode
        )
        XCTAssertTrue(required.required)
        let add = try XCTUnwrap(
            SharedWakeSettingsScreenModel.action(.addCode("123")) as? SharedSDK.WakeSettingsActionAddCode
        )
        XCTAssertEqual(add.code, "123")
        let remove = try XCTUnwrap(
            SharedWakeSettingsScreenModel.action(.removeCode("456")) as? SharedSDK.WakeSettingsActionRemoveCode
        )
        XCTAssertEqual(remove.code, "456")
        XCTAssertEqual(
            SharedWakeSettingsScreenModel.action(.dismissFailure) as? NSObject,
            SharedSDK.WakeSettingsActionDismissFailure.shared
        )
    }

    // MARK: - Wake guard mapping
    @MainActor
    func testTheWakeGuardStateMapsEveryField() {
        let state = SharedWakeGuardScreenModel.state(SharedSDK.WakeGuardState(
            phase: .tapping,
            tapsLeft: 150,
            requiredTaps: 200,
            fallbackDelayMinutes: 10,
            fallbackOpensAtEpochSeconds: KotlinLong(value: 1_800_000_000),
            fallbackOpen: true,
            codeCount: 2,
            titleKind: .sleepAlarm
        ))

        XCTAssertEqual(state, WakeGuardState(
            phase: .tapping,
            tapsLeft: 150,
            requiredTaps: 200,
            fallbackDelayMinutes: 10,
            fallbackOpensAt: Date(timeIntervalSince1970: 1_800_000_000),
            fallbackOpen: true,
            codeCount: 2,
            titleKind: .sleepAlarm
        ))
        XCTAssertNil(SharedWakeGuardScreenModel.state(SharedSDK.WakeGuardState(
            phase: .idle, tapsLeft: 200, requiredTaps: 200, fallbackDelayMinutes: 10,
            fallbackOpensAtEpochSeconds: nil, fallbackOpen: false, codeCount: 0, titleKind: .sleepAlarm
        )).fallbackOpensAt)
    }

    @MainActor
    func testEveryWakeGuardPhaseMaps() {
        XCTAssertEqual(SharedWakeGuardScreenModel.phase(.idle), .idle)
        XCTAssertEqual(SharedWakeGuardScreenModel.phase(.scanning), .scanning)
        XCTAssertEqual(SharedWakeGuardScreenModel.phase(.tapping), .tapping)
        XCTAssertEqual(SharedWakeGuardScreenModel.titleKind(.sleepAlarm), .sleepAlarm)
    }

    @MainActor
    func testEveryWakeGuardActionMapsToItsKotlinAction() throws {
        let scanned = try XCTUnwrap(
            SharedWakeGuardScreenModel.action(.codeScanned("123")) as? SharedSDK.WakeGuardActionCodeScanned
        )
        XCTAssertEqual(scanned.code, "123")
        XCTAssertEqual(SharedWakeGuardScreenModel.action(.tap) as? NSObject, SharedSDK.WakeGuardActionTap.shared)
        XCTAssertEqual(
            SharedWakeGuardScreenModel.action(.openTapFallback) as? NSObject,
            SharedSDK.WakeGuardActionOpenTapFallback.shared
        )
        XCTAssertEqual(
            SharedWakeGuardScreenModel.action(.backToScanning) as? NSObject,
            SharedSDK.WakeGuardActionBackToScanning.shared
        )
    }

    @MainActor
    func testEveryWakeGuardEffectMaps() {
        XCTAssertEqual(SharedWakeGuardScreenModel.effect(SharedSDK.WakeGuardEffectCodeRejected.shared), .codeRejected)
        XCTAssertEqual(SharedWakeGuardScreenModel.effect(SharedSDK.WakeGuardEffectFinished.shared), .finished)
    }

    // MARK: - The real Kotlin ViewModels
    @MainActor
    func testTheRealWakeSettingsViewModelKeepsACodeAndTheBridgeSeesIt() throws {
        let model = try XCTUnwrap(isolatedFactory().makeWakeSettings() as? SharedWakeSettingsScreenModel)

        model.send(.setRequiresCode(true))
        model.send(.addCode(" 123 "))

        XCTAssertEqual(model.state.codes, ["123"])
        XCTAssertEqual(model.state.mode, .active)
        model.send(.addCode("   "))
        XCTAssertEqual(model.state.failure, .emptyCode)
        model.send(.dismissFailure)
        XCTAssertNil(model.state.failure)
        model.send(.removeCode("123"))
        XCTAssertEqual(model.state.mode, .needsCode)
    }

    @MainActor
    func testTheWakeSettingsStatesReachAnObserverWhenAnActionChangesThem() async throws {
        let model = try XCTUnwrap(isolatedFactory().makeWakeSettings() as? SharedWakeSettingsScreenModel)

        model.send(.setRequiresCode(true))
        let changed = await Self.firstState(of: model) { $0.requiresCode }

        XCTAssertEqual(changed?.mode, .needsCode)
    }

    @MainActor
    func testReleasingTheWakeBridgesClosesTheirKotlinViewModels() throws {
        var settings: SharedWakeSettingsScreenModel? = try XCTUnwrap(
            isolatedFactory().makeWakeSettings() as? SharedWakeSettingsScreenModel
        )
        var guardModel: SharedWakeGuardScreenModel? = try XCTUnwrap(
            isolatedFactory().makeWakeGuard() as? SharedWakeGuardScreenModel
        )
        let settingsViewModel = try XCTUnwrap(settings?.viewModel)
        let guardViewModel = try XCTUnwrap(guardModel?.viewModel)
        XCTAssertFalse(settingsViewModel.isClosed)
        XCTAssertFalse(guardViewModel.isClosed)

        settings = nil
        guardModel = nil

        XCTAssertTrue(settingsViewModel.isClosed)
        XCTAssertTrue(guardViewModel.isClosed)
    }

    @MainActor
    func testARingingMissionCoversTheWindowAndTheBridgeDeliversItsEffectsOnce() async throws {
        let defaults = try Self.isolatedDefaults()
        let storage = DefaultsWakeStorage(defaults: defaults)
        storage.saveMissions(missions: [
            SharedSDK.WakeMission(
                key: "sleep:k",
                ringAtEpochSeconds: Int64(Date().timeIntervalSince1970) - 60,
                alarmId: "a1",
                codes: ["123"],
                watchIds: [],
                armed: true
            )
        ])
        let push = SharedSDK.DevicePushSDK(
            sessionStorage: SharedSDK.InMemorySessionStorage(),
            subscriptions: SharedSDK.InMemoryPushSubscriptionStorage(),
            alarms: SharedSDK.UnavailableDeviceAlarms(),
            sleepAlarmLedger: SharedSDK.InMemorySleepAlarmLedger(),
            wakeStorage: storage
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
            sleepAlarms: push.sleepAlarms
        )
        let model = SharedWakeGuardScreenModel(home.sleep.wakeGuardViewModel())
        let covered = await Self.firstState(of: model) { $0.phase == .scanning }
        XCTAssertEqual(covered?.codeCount, 1)
        XCTAssertEqual(covered?.requiredTaps, 200)
        XCTAssertEqual(covered?.fallbackDelayMinutes, 10)

        var effects = model.effects().makeAsyncIterator()
        model.send(.codeScanned("999"))
        let rejected = await effects.next()
        XCTAssertEqual(rejected, .codeRejected)
        XCTAssertEqual(model.state.phase, .scanning)

        model.send(.codeScanned("123"))
        let finished = await effects.next()
        XCTAssertEqual(finished, .finished)
        let idle = await Self.firstState(of: model) { $0.phase == .idle }
        XCTAssertEqual(idle?.phase, .idle)
        XCTAssertEqual(DefaultsWakeStorage(defaults: defaults).loadMissions().count, 0)
    }

    // MARK: - Wake storage
    @MainActor
    func testTheWakeStorageKeepsSettingsAndMissionsAcrossInstances() throws {
        let defaults = try Self.isolatedDefaults()
        let storage = DefaultsWakeStorage(defaults: defaults)
        XCTAssertFalse(storage.loadSettings().requiresCode)
        XCTAssertEqual(storage.loadMissions().count, 0)

        storage.saveSettings(settings: SharedSDK.WakeSettings(requiresCode: true, codes: ["1", "2"]))
        storage.saveMissions(missions: [
            SharedSDK.WakeMission(
                key: "sleep:k", ringAtEpochSeconds: 100, alarmId: "a", codes: ["1"], watchIds: ["w1", "w2"], armed: true
            )
        ])

        let again = DefaultsWakeStorage(defaults: defaults)
        XCTAssertEqual(again.loadSettings().requiresCode, true)
        XCTAssertEqual(again.loadSettings().codes, ["1", "2"])
        let mission = try XCTUnwrap(again.loadMissions().first)
        XCTAssertEqual(mission.key, "sleep:k")
        XCTAssertEqual(mission.ringAtEpochSeconds, 100)
        XCTAssertEqual(mission.alarmId, "a")
        XCTAssertEqual(mission.codes, ["1"])
        XCTAssertEqual(mission.watchIds, ["w1", "w2"])
        XCTAssertTrue(mission.armed)
    }

    @MainActor
    func testStoredValuesThatCannotBeReadCountAsNothingStored() throws {
        let defaults = try Self.isolatedDefaults()
        defaults.set(Data("not json".utf8), forKey: "cz.semprec.wakeSettings")
        defaults.set(Data("not json".utf8), forKey: "cz.semprec.wakeMissions")

        let storage = DefaultsWakeStorage(defaults: defaults)

        XCTAssertFalse(storage.loadSettings().requiresCode)
        XCTAssertEqual(storage.loadSettings().codes, [])
        XCTAssertEqual(storage.loadMissions().count, 0)
    }

    // MARK: - The camera's codes
    func testACodeIsReportedOnceWhileTheCameraKeepsSeeingItAndAgainAfterTheInterval() {
        var filter = CodeRepeatFilter()
        let start = Date(timeIntervalSince1970: 1_000)

        XCTAssertTrue(filter.accepts("123", at: start))
        XCTAssertFalse(filter.accepts("123", at: start.addingTimeInterval(0.1)))
        XCTAssertFalse(filter.accepts("123", at: start.addingTimeInterval(1.9)))
        XCTAssertTrue(filter.accepts("123", at: start.addingTimeInterval(2)))
        XCTAssertTrue(filter.accepts("456", at: start.addingTimeInterval(2.1)))
        XCTAssertTrue(filter.accepts("123", at: start.addingTimeInterval(2.2)), "another code in between resets it")
    }
}

// MARK: - Helpers
private extension SharedWakeTests {

    static func isolatedDefaults() throws -> UserDefaults {
        try XCTUnwrap(UserDefaults(suiteName: "cz.semprec.tests.\(UUID().uuidString)"))
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
