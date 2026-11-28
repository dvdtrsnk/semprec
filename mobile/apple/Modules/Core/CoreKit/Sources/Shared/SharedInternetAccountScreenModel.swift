@preconcurrency internal import SharedSDK

/// The Kotlin `InternetAccountViewModel` as an `InternetAccountScreenModel`. Releasing the bridge closes the Kotlin
/// ViewModel.
@MainActor
final class SharedInternetAccountScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.InternetAccountViewModel
    private let effectQueue: EffectQueue<InternetAccountEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.InternetAccountViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedInternetAccountScreenModel: ScreenModel {

    var state: InternetAccountState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<InternetAccountState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<InternetAccountEffect> {
        effectQueue.stream()
    }

    func send(_ action: InternetAccountAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedInternetAccountScreenModel {

    static func state(_ state: SharedSDK.InternetAccountState) -> InternetAccountState {
        InternetAccountState(
            phase: phase(state),
            account: state.account.map(account),
            confirmingOff: state.confirmingOff.map(InternetAccountService.init),
            syncRequested: state.syncRequested,
            removal: removal(state.removal),
            impact: state.impact.map {
                InternetAccountRemovalImpact(
                    messages: Int($0.messages),
                    drafts: Int($0.drafts),
                    threads: Int($0.threads),
                    attachmentsKept: Int($0.attachmentsKept)
                )
            },
            actionFailed: state.actionFailed,
            signingIn: state.signingIn,
            signInFailure: state.signInFailure.map(InternetConnectFailure.init),
            passwordSignIn: state.passwordSignIn.map(InternetPasswordSignIn.init)
        )
    }

    static func action(_ action: InternetAccountAction) -> any SharedSDK.InternetAccountAction {
        switch action {
        case .retry: SharedSDK.InternetAccountActionRetry.shared
        case .setService(let service, let enabled):
            SharedSDK.InternetAccountActionSetService(service: service.shared, enabled: enabled)
        case .confirmServiceOff: SharedSDK.InternetAccountActionConfirmServiceOff.shared
        case .cancelServiceOff: SharedSDK.InternetAccountActionCancelServiceOff.shared
        case .rename(let name): SharedSDK.InternetAccountActionRename(name: name)
        case .stepConnectionLimit(let delta):
            SharedSDK.InternetAccountActionStepConnectionLimit(delta: Int32(delta))
        case .syncNow: SharedSDK.InternetAccountActionSyncNow.shared
        case .requestRemoval: SharedSDK.InternetAccountActionRemovalRequest.shared
        case .cancelRemoval: SharedSDK.InternetAccountActionRemovalCancel.shared
        case .confirmRemoval: SharedSDK.InternetAccountActionRemovalConfirm.shared
        case .dismissFailure: SharedSDK.InternetAccountActionDismissFailure.shared
        case .signIn(let step): signIn(step)
        case .passwordSignIn(let step): SharedSDK.InternetAccountActionPasswordSignIn(step: step.shared)
        }
    }

    private static func signIn(_ step: InternetAccountSignIn) -> any SharedSDK.InternetAccountActionSignIn {
        switch step {
        case .again: SharedSDK.InternetAccountActionSignInAgain.shared
        case .allowCalendarAccess: SharedSDK.InternetAccountActionSignInAllowCalendarAccess.shared
        case .returned(let url): SharedSDK.InternetAccountActionSignInReturned(callbackUrl: url)
        case .cancelled: SharedSDK.InternetAccountActionSignInCancelled.shared
        case .failed: SharedSDK.InternetAccountActionSignInFailed.shared
        }
    }

    static func effect(_ effect: any SharedSDK.InternetAccountEffect) -> InternetAccountEffect {
        switch onEnum(of: effect) {
        case .removed: .removed
        case .calendarsTurnedOn: .calendarsTurnedOn
        case .openSignIn(let open): .openSignIn(url: open.url)
        }
    }

    private static func phase(_ state: SharedSDK.InternetAccountState) -> InternetAccountPhase {
        switch state.phase {
        case .loading: .loading
        case .content: .content
        case .error: .failure(state.failure.map(FailureKind.init))
        }
    }

    private static func removal(_ phase: SharedSDK.InternetAccountRemovalPhase) -> InternetAccountRemovalPhase {
        switch phase {
        case .idle: .idle
        case .loadingImpact: .loadingImpact
        case .confirming: .confirming
        case .removing: .removing
        }
    }

    private static func account(_ account: SharedSDK.InternetAccountDetail) -> InternetAccountDetail {
        InternetAccountDetail(
            id: account.id,
            name: account.name,
            address: account.address,
            provider: account.provider,
            syncMode: account.syncMode,
            mailEnabled: account.mailEnabled,
            calendarsEnabled: account.calendarsEnabled,
            mail: InternetServiceStatus(account.mail),
            calendars: InternetServiceStatus(account.calendars),
            lastSuccessfulSyncAt: account.lastSuccessfulSyncAt,
            failingSince: account.failingSince,
            connectionLimit: Int(account.connectionLimit),
            connectionLimitApplies: account.connectionLimitApplies,
            autonomousSendProjectCount: Int(account.autonomousSendProjectCount),
            syncedMessageCount: account.syncedMessageCount?.intValue,
            signsInInBrowser: account.signsInInBrowser,
            canSignInAgain: account.canSignInAgain,
            canAllowCalendarAccess: account.canAllowCalendarAccess
        )
    }
}
