@preconcurrency internal import SharedSDK

/// The Kotlin `MailAccountsViewModel` as a `MailAccountsScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedMailAccountsScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.MailAccountsViewModel
    private let effectQueue: EffectQueue<MailAccountsEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.MailAccountsViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedMailAccountsScreenModel: ScreenModel {

    var state: MailAccountsState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<MailAccountsState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<MailAccountsEffect> {
        effectQueue.stream()
    }

    func send(_ action: MailAccountsAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedMailAccountsScreenModel {

    static func state(_ state: SharedSDK.MailAccountsState) -> MailAccountsState {
        MailAccountsState(
            phase: phase(state),
            refreshing: state.refreshing,
            accounts: state.accounts.map {
                MailAccountItem(
                    id: $0.id,
                    name: $0.name,
                    address: $0.address,
                    provider: $0.provider,
                    status: MailAccountStatus($0.status)
                )
            },
            connecting: state.connecting,
            connectFailure: state.connectFailure.map(connectFailure)
        )
    }

    static func action(_ action: MailAccountsAction) -> any SharedSDK.MailAccountsAction {
        switch action {
        case .retry: SharedSDK.MailAccountsActionRetry.shared
        case .refresh: SharedSDK.MailAccountsActionRefresh.shared
        case .open(let id): SharedSDK.MailAccountsActionOpen(mailboxId: id)
        case .connect(let kind, let address, let password, let imapHost, let smtpHost):
            SharedSDK.MailAccountsActionConnect(
                kind: sharedKind(kind),
                address: address,
                password: password,
                imapHost: imapHost,
                smtpHost: smtpHost
            )
        case .dismissConnectFailure: SharedSDK.MailAccountsActionDismissConnectFailure.shared
        }
    }

    static func effect(_ effect: any SharedSDK.MailAccountsEffect) -> MailAccountsEffect {
        switch onEnum(of: effect) {
        case .openAccount(let open): .openAccount(mailboxId: open.mailboxId)
        case .connected: .connected
        }
    }

    private static func phase(_ state: SharedSDK.MailAccountsState) -> MailAccountsPhase {
        switch state.phase {
        case .loading: .loading
        case .content: .content
        case .error: .failure(state.failure.map(FailureKind.init))
        }
    }

    private static func sharedKind(_ kind: MailConnectKind) -> SharedSDK.MailConnectKind {
        switch kind {
        case .icloud: .icloud
        case .generic: .generic
        }
    }

    private static func connectFailure(_ failure: SharedSDK.MailConnectFailure) -> MailConnectFailure {
        switch failure {
        case .invalidInput: .invalidInput
        case .refused: .refused
        case .unavailable: .unavailable
        case .unexpected: .unexpected
        }
    }
}
