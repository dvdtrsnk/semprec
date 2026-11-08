@preconcurrency internal import SharedSDK

/// The Kotlin `SettingsViewModel` as a `SettingsScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedSettingsScreenModel {

    // MARK: - Dependencies
    private let viewModel: SharedSDK.SettingsViewModel
    private let effectQueue: EffectQueue<SettingsEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.SettingsViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedSettingsScreenModel: ScreenModel {

    var state: SettingsState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<SettingsState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<SettingsEffect> {
        effectQueue.stream()
    }

    func send(_ action: SettingsAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedSettingsScreenModel {

    static func state(_ state: SharedSDK.SettingsState) -> SettingsState {
        SettingsState(rows: state.rows.map(SettingsRow.init))
    }

    static func action(_ action: SettingsAction) -> any SharedSDK.SettingsAction {
        switch action {
        case .selectRow(let row): SharedSDK.SettingsActionSelectRow(row: row.shared)
        }
    }

    static func effect(_ effect: any SharedSDK.SettingsEffect) -> SettingsEffect {
        switch onEnum(of: effect) {
        case .showAbout: .showAbout
        }
    }
}
