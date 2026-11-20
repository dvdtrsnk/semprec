@preconcurrency internal import SharedSDK

/// The Kotlin `InternetAccountsViewModel` as an `InternetAccountsScreenModel`. Releasing the bridge closes the Kotlin
/// ViewModel.
@MainActor
final class SharedInternetAccountsScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.InternetAccountsViewModel
    private let effectQueue: EffectQueue<InternetAccountsEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.InternetAccountsViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedInternetAccountsScreenModel: ScreenModel {

    var state: InternetAccountsState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<InternetAccountsState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<InternetAccountsEffect> {
        effectQueue.stream()
    }

    func send(_ action: InternetAccountsAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedInternetAccountsScreenModel {

    static func state(_ state: SharedSDK.InternetAccountsState) -> InternetAccountsState {
        InternetAccountsState(
            phase: phase(state),
            refreshing: state.refreshing,
            accounts: state.accounts.map {
                InternetAccountItem(
                    id: $0.id,
                    name: $0.name,
                    address: $0.address,
                    provider: $0.provider,
                    mail: InternetServiceStatus($0.mail),
                    calendars: InternetServiceStatus($0.calendars)
                )
            },
            connecting: state.connecting,
            connectFailure: state.connectFailure.map(InternetConnectFailure.init)
        )
    }

    static func action(_ action: InternetAccountsAction) -> any SharedSDK.InternetAccountsAction {
        switch action {
        case .retry: SharedSDK.InternetAccountsActionRetry.shared
        case .refresh: SharedSDK.InternetAccountsActionRefresh.shared
        case .open(let id): SharedSDK.InternetAccountsActionOpen(accountId: id)
        case .connect(let provider, let address, let password, let imapHost, let smtpHost, let caldavUrl):
            SharedSDK.InternetAccountsActionConnect(
                provider: sharedProvider(provider),
                address: address,
                password: password,
                imapHost: imapHost,
                smtpHost: smtpHost,
                caldavUrl: caldavUrl
            )
        case .dismissConnectFailure: SharedSDK.InternetAccountsActionDismissConnectFailure.shared
        case .startSignIn(let provider, let calendars):
            SharedSDK.InternetAccountsActionSignInStart(provider: sharedProvider(provider), calendars: calendars)
        case .signInReturned(let url): SharedSDK.InternetAccountsActionSignInReturned(callbackUrl: url)
        case .signInCancelled: SharedSDK.InternetAccountsActionSignInCancelled.shared
        case .signInFailed: SharedSDK.InternetAccountsActionSignInFailed.shared
        }
    }

    static func effect(_ effect: any SharedSDK.InternetAccountsEffect) -> InternetAccountsEffect {
        switch onEnum(of: effect) {
        case .openAccount(let open): .openAccount(accountId: open.accountId)
        case .connected: .connected
        case .openSignIn(let open): .openSignIn(url: open.url)
        }
    }

    private static func phase(_ state: SharedSDK.InternetAccountsState) -> InternetAccountsPhase {
        switch state.phase {
        case .loading: .loading
        case .content: .content
        case .error: .failure(state.failure.map(FailureKind.init))
        }
    }

    private static func sharedProvider(_ provider: InternetPasswordProvider) -> SharedSDK.InternetPasswordProvider {
        switch provider {
        case .icloud: .icloud
        case .other: .other
        }
    }

    private static func sharedProvider(_ provider: InternetOAuthProvider) -> SharedSDK.InternetOAuthProvider {
        switch provider {
        case .google: .google
        case .microsoft: .microsoft
        }
    }
}
