@preconcurrency internal import SharedSDK

/// The Kotlin `DevicesViewModel` as a `DevicesScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedDevicesScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.DevicesViewModel
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.DevicesViewModel) {
        self.viewModel = viewModel
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedDevicesScreenModel: ScreenModel {

    var state: DevicesState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<DevicesState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    /// The Kotlin ViewModel's effect type is `Nothing`, so the stream has no elements.
    func effects() -> AsyncStream<Never> {
        AsyncStream { $0.finish() }
    }

    func send(_ action: DevicesAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedDevicesScreenModel {

    static func state(_ state: SharedSDK.DevicesState) -> DevicesState {
        DevicesState(
            phase: phase(state.phase),
            failure: state.failure.map(FailureKind.init),
            current: state.current.map(item),
            others: state.others.map(item),
            confirm: state.confirm.map(confirm),
            working: state.working,
            writeFailure: state.writeFailure.map(Failed.init)
        )
    }

    private static func phase(_ phase: SharedSDK.DevicesPhase) -> DevicesPhase {
        switch phase {
        case .loading: .loading
        case .content: .content
        case .error: .error
        }
    }

    static func item(_ item: SharedSDK.DeviceItem) -> DeviceItem {
        DeviceItem(
            id: item.id,
            kind: kind(item.kind),
            platform: platform(item.platform),
            name: item.name,
            createdAt: item.createdAt,
            lastSeenAt: item.lastSeenAt
        )
    }

    static func kind(_ kind: SharedSDK.AccountDeviceKind) -> AccountDeviceKind {
        switch kind {
        case .iphone: .iphone
        case .ipad: .ipad
        case .mac: .mac
        case .browser: .browser
        case .unknown: .unknown
        }
    }

    static func platform(_ platform: SharedSDK.AccountPlatform) -> AccountPlatform {
        switch platform {
        case .web: .web
        case .ios: .ios
        case .macos: .macos
        case .unknown: .unknown
        }
    }

    static func confirm(_ confirm: any SharedSDK.DevicesConfirm) -> DevicesConfirm {
        switch onEnum(of: confirm) {
        case .one(let one): .one(item(one.device))
        case .others: .others
        }
    }

    static func action(_ action: DevicesAction) -> any SharedSDK.DevicesAction {
        switch action {
        case .retry: SharedSDK.DevicesActionRetry.shared
        case .ask(let deviceId): SharedSDK.DevicesActionAsk(deviceId: deviceId)
        case .askOthers: SharedSDK.DevicesActionAskOthers.shared
        case .cancel: SharedSDK.DevicesActionCancel.shared
        case .confirm: SharedSDK.DevicesActionConfirm.shared
        case .dismissFailure: SharedSDK.DevicesActionDismissFailure.shared
        }
    }
}
