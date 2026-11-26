import Foundation
@preconcurrency internal import SharedSDK

/// The Kotlin `DebugAlarmViewModel` as a `DebugAlarmScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedDebugAlarmScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.DebugAlarmViewModel
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.DebugAlarmViewModel) {
        self.viewModel = viewModel
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedDebugAlarmScreenModel: ScreenModel {

    var state: DebugAlarmState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<DebugAlarmState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    /// The Kotlin ViewModel's effect type is `Nothing`, so the stream has no elements.
    func effects() -> AsyncStream<Never> {
        AsyncStream { $0.finish() }
    }

    func send(_ action: DebugAlarmAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedDebugAlarmScreenModel {

    static func state(_ state: SharedSDK.DebugAlarmState) -> DebugAlarmState {
        DebugAlarmState(
            authorization: authorization(state.authorization),
            alarms: state.alarms.map(row),
            codeCount: Int(state.codeCount),
            dailyDays: Int(state.dailyDays),
            busy: state.busy,
            failure: state.failure.map(failure)
        )
    }

    static func row(_ row: SharedSDK.DebugAlarmRow) -> DebugAlarmRow {
        DebugAlarmRow(
            id: row.id,
            kind: kind(row.kind),
            source: source(row.source),
            ringAt: row.ringAtEpochSeconds.map { Date(timeIntervalSince1970: TimeInterval($0.int64Value)) },
            phase: row.phase.map(phase),
            codeCount: Int(row.codeCount),
            watchCount: Int(row.watchCount)
        )
    }

    static func authorization(_ authorization: SharedSDK.DeviceAlarmAuthorization) -> DebugAlarmAuthorization {
        switch authorization {
        case .notDetermined: .notDetermined
        case .denied: .denied
        case .authorized: .authorized
        case .unsupported: .unsupported
        }
    }

    static func phase(_ phase: SharedSDK.DeviceAlarmPhase) -> DebugAlarmPhase {
        switch phase {
        case .scheduled: .scheduled
        case .alerting: .alerting
        }
    }

    static func kind(_ kind: SharedSDK.DebugAlarmKind) -> DebugAlarmKind {
        switch kind {
        case .alarm: .alarm
        case .mission: .mission
        }
    }

    static func source(_ source: SharedSDK.DebugAlarmSource) -> DebugAlarmSource {
        switch source {
        case .sleepPlan: .sleepPlan
        case .debug: .debug
        case .unknown: .unknown
        }
    }

    static func failure(_ failure: SharedSDK.DebugAlarmFailure) -> DebugAlarmFailure {
        switch failure {
        case .notAuthorized: .notAuthorized
        case .limitReached: .limitReached
        case .unsupported: .unsupported
        case .deviceFailed: .deviceFailed
        case .readFailed: .readFailed
        case .noCodes: .noCodes
        case .inThePast: .inThePast
        case .invalidTime: .invalidTime
        }
    }

    static func delay(_ delay: DebugAlarmDelay) -> SharedSDK.DebugAlarmDelay {
        switch delay {
        case .tenSeconds: .tenSeconds
        case .oneMinute: .oneMinute
        case .fiveMinutes: .fiveMinutes
        }
    }

    static func `repeat`(_ repeats: DebugAlarmRepeat) -> SharedSDK.DebugAlarmRepeat {
        switch repeats {
        case .once: .once
        case .daily: .daily
        }
    }

    static func action(_ action: DebugAlarmAction) -> any SharedSDK.DebugAlarmAction {
        switch action {
        case .refresh:
            SharedSDK.DebugAlarmActionRefresh.shared
        case .requestAuthorization:
            SharedSDK.DebugAlarmActionRequestAuthorization.shared
        case .ringIn(let delay, let withCodes):
            SharedSDK.DebugAlarmActionRingIn(delay: Self.delay(delay), withCodes: withCodes)
        case .ringAt(let date, let repeats, let withCodes):
            SharedSDK.DebugAlarmActionRingAt(
                epochSeconds: Int64(date.timeIntervalSince1970.rounded(.down)),
                repeat: Self.repeat(repeats),
                withCodes: withCodes
            )
        case .cancel(let id):
            SharedSDK.DebugAlarmActionCancel(id: id)
        case .cancelAll:
            SharedSDK.DebugAlarmActionCancelAll.shared
        case .dismissFailure:
            SharedSDK.DebugAlarmActionDismissFailure.shared
        }
    }
}
