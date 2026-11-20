@preconcurrency internal import SharedSDK

/// The Kotlin `NotificationSettingsViewModel` as a `NotificationSettingsScreenModel`. Releasing the bridge closes the
/// Kotlin ViewModel.
@MainActor
final class SharedNotificationSettingsScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.NotificationSettingsViewModel
    private let effectQueue: EffectQueue<NotificationSettingsEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.NotificationSettingsViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedNotificationSettingsScreenModel: ScreenModel {

    var state: NotificationSettingsState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<NotificationSettingsState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<NotificationSettingsEffect> {
        effectQueue.stream()
    }

    func send(_ action: NotificationSettingsAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedNotificationSettingsScreenModel {

    static func state(_ state: SharedSDK.NotificationSettingsState) -> NotificationSettingsState {
        NotificationSettingsState(
            phase: phase(state.phase),
            failure: state.failure.map(FailureKind.init),
            choices: state.choices.map(choices),
            writeFailure: state.writeFailure.map(Failed.init)
        )
    }

    private static func phase(_ phase: SharedSDK.NotificationSettingsPhase) -> NotificationSettingsPhase {
        switch phase {
        case .loading: .loading
        case .content: .content
        case .error: .error
        }
    }

    static func choices(_ choices: SharedSDK.NotificationChoices) -> NotificationChoices {
        NotificationChoices(
            approvals: choices.approvals,
            invites: choices.invites,
            reminders: choices.reminders,
            problemsLevel: level(choices.problemsLevel),
            problemsSummary: choices.problemsSummary,
            badgeApprovals: choices.badgeApprovals,
            badgeInvites: choices.badgeInvites,
            badgeInbox: choices.badgeInbox
        )
    }

    static func level(_ level: SharedSDK.AccountProblemsLevel) -> AccountProblemsLevel {
        switch level {
        case .off: .off
        case .critical: .critical
        case .all: .all
        }
    }

    static func sharedLevel(_ level: AccountProblemsLevel) -> SharedSDK.AccountProblemsLevel {
        switch level {
        case .off: .off
        case .critical: .critical
        case .all: .all
        }
    }

    static func sharedSwitch(_ choice: AccountNotificationSwitch) -> SharedSDK.AccountNotificationSwitch {
        switch choice {
        case .approvals: .approvals
        case .invites: .invites
        case .reminders: .reminders
        case .problemsSummary: .problemsSummary
        case .badgeApprovals: .badgeApprovals
        case .badgeInvites: .badgeInvites
        case .badgeInbox: .badgeInbox
        }
    }

    static func effect(_ effect: any SharedSDK.NotificationSettingsEffect) -> NotificationSettingsEffect {
        switch onEnum(of: effect) {
        case .requestPermission: .requestPermission
        }
    }

    static func action(_ action: NotificationSettingsAction) -> any SharedSDK.NotificationSettingsAction {
        switch action {
        case .retry: SharedSDK.NotificationSettingsActionRetry.shared
        case .set(let choice, let enabled):
            SharedSDK.NotificationSettingsActionSet(choice: sharedSwitch(choice), on: enabled)
        case .setProblemsLevel(let level):
            SharedSDK.NotificationSettingsActionSetProblemsLevel(level: sharedLevel(level))
        case .dismissFailure: SharedSDK.NotificationSettingsActionDismissFailure.shared
        }
    }
}
