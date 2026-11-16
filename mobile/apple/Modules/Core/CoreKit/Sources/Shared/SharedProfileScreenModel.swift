@preconcurrency internal import SharedSDK

/// The Kotlin `ProfileViewModel` as a `ProfileScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedProfileScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.ProfileViewModel
    private let effectQueue: EffectQueue<AccountPage>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.ProfileViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedProfileScreenModel: ScreenModel {

    var state: ProfileState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<ProfileState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<AccountPage> {
        effectQueue.stream()
    }

    func send(_ action: ProfileAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedProfileScreenModel {

    static func state(_ state: SharedSDK.ProfileState) -> ProfileState {
        ProfileState(
            phase: phase(state.phase),
            failure: state.failure.map(FailureKind.init),
            email: state.email,
            serverUrl: state.serverUrl,
            locale: state.locale,
            locales: state.locales,
            figures: state.figures.map {
                ProfileFigures(
                    activeSessions: Int($0.activeSessions),
                    mailAccountCount: Int($0.mailAccountCount),
                    mailAccountsNeedingReauth: Int($0.mailAccountsNeedingReauth),
                    trashCount: Int($0.trashCount),
                    problemCount: Int($0.problemCount),
                    aiCostMonthUsd: $0.aiCostMonthUsd
                )
            },
            localeSaving: state.localeSaving,
            resetPhase: resetPhase(state.resetPhase),
            writeFailure: state.writeFailure.map(Failed.init)
        )
    }

    private static func phase(_ phase: SharedSDK.ProfilePhase) -> ProfilePhase {
        switch phase {
        case .loading: .loading
        case .content: .content
        case .error: .error
        }
    }

    private static func resetPhase(_ phase: SharedSDK.ProfileResetPhase) -> ProfileResetPhase {
        switch phase {
        case .idle: .idle
        case .sending: .sending
        case .sent: .sent
        case .failed: .failed
        }
    }

    static func action(_ action: ProfileAction) -> any SharedSDK.ProfileAction {
        switch action {
        case .retry: SharedSDK.ProfileActionRetry.shared
        case .open(let page): SharedSDK.ProfileActionOpen(page: sharedPage(page))
        case .changeLocale(let locale): SharedSDK.ProfileActionChangeLocale(locale: locale)
        case .requestPasswordReset: SharedSDK.ProfileActionRequestPasswordReset.shared
        case .signOut: SharedSDK.ProfileActionSignOut.shared
        case .dismissFailure: SharedSDK.ProfileActionDismissFailure.shared
        }
    }

    static func effect(_ effect: any SharedSDK.ProfileEffect) -> AccountPage {
        switch onEnum(of: effect) {
        case .open(let open): page(open.page)
        }
    }

    static func page(_ page: SharedSDK.AccountPage) -> AccountPage {
        switch page {
        case .devices: .devices
        case .notifications: .notifications
        case .aiUsage: .aiUsage
        case .trash: .trash
        case .sempStatus: .sempStatus
        case .mailAccounts: .mailAccounts
        }
    }

    static func sharedPage(_ page: AccountPage) -> SharedSDK.AccountPage {
        switch page {
        case .devices: .devices
        case .notifications: .notifications
        case .aiUsage: .aiUsage
        case .trash: .trash
        case .sempStatus: .sempStatus
        case .mailAccounts: .mailAccounts
        }
    }
}
