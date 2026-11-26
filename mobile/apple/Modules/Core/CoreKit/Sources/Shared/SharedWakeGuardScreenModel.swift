import Foundation
@preconcurrency internal import SharedSDK

/// The Kotlin `WakeGuardViewModel` as a `WakeGuardScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedWakeGuardScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.WakeGuardViewModel
    private let effectQueue: EffectQueue<WakeGuardEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.WakeGuardViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedWakeGuardScreenModel: ScreenModel {

    var state: WakeGuardState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<WakeGuardState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<WakeGuardEffect> {
        effectQueue.stream()
    }

    func send(_ action: WakeGuardAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedWakeGuardScreenModel {

    static func state(_ state: SharedSDK.WakeGuardState) -> WakeGuardState {
        WakeGuardState(
            phase: phase(state.phase),
            tapsLeft: Int(state.tapsLeft),
            requiredTaps: Int(state.requiredTaps),
            fallbackDelayMinutes: Int(state.fallbackDelayMinutes),
            fallbackOpensAt: state.fallbackOpensAtEpochSeconds.map { Date(timeIntervalSince1970: $0.doubleValue) },
            fallbackOpen: state.fallbackOpen,
            codeCount: Int(state.codeCount),
            titleKind: titleKind(state.titleKind)
        )
    }

    static func phase(_ phase: SharedSDK.WakeGuardPhase) -> WakeGuardPhase {
        switch phase {
        case .idle: .idle
        case .scanning: .scanning
        case .tapping: .tapping
        }
    }

    static func titleKind(_ kind: SharedSDK.WakeTitleKind) -> WakeTitleKind {
        switch kind {
        case .sleepAlarm: .sleepAlarm
        }
    }

    static func action(_ action: WakeGuardAction) -> any SharedSDK.WakeGuardAction {
        switch action {
        case .codeScanned(let code): SharedSDK.WakeGuardActionCodeScanned(code: code)
        case .tap: SharedSDK.WakeGuardActionTap.shared
        case .openTapFallback: SharedSDK.WakeGuardActionOpenTapFallback.shared
        case .backToScanning: SharedSDK.WakeGuardActionBackToScanning.shared
        }
    }

    static func effect(_ effect: any SharedSDK.WakeGuardEffect) -> WakeGuardEffect {
        switch onEnum(of: effect) {
        case .codeRejected: .codeRejected
        case .finished: .finished
        }
    }
}
