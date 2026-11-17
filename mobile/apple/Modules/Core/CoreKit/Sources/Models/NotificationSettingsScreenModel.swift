import Foundation

/// How much of what goes wrong with Semp is pushed to the person.
public enum AccountProblemsLevel: Equatable, Sendable, CaseIterable {

    case off
    case critical
    case all
}

/// The switches of the notification settings a person changes one at a time.
public enum AccountNotificationSwitch: Equatable, Sendable, CaseIterable {

    case approvals
    case invites
    case reminders
    case problemsSummary
    case badgeApprovals
    case badgeInvites
    case badgeInbox
}

public enum NotificationSettingsPhase: Equatable, Sendable {

    case loading
    case content
    case error
}

/// What the person asked to be notified about.
public struct NotificationChoices: Equatable, Sendable {

    public var approvals: Bool
    public var invites: Bool
    public var reminders: Bool
    public var problemsLevel: AccountProblemsLevel
    public var problemsSummary: Bool
    public var badgeApprovals: Bool
    public var badgeInvites: Bool
    public var badgeInbox: Bool

    public init(
        approvals: Bool = true,
        invites: Bool = true,
        reminders: Bool = true,
        problemsLevel: AccountProblemsLevel = .critical,
        problemsSummary: Bool = true,
        badgeApprovals: Bool = true,
        badgeInvites: Bool = true,
        badgeInbox: Bool = false
    ) {
        self.approvals = approvals
        self.invites = invites
        self.reminders = reminders
        self.problemsLevel = problemsLevel
        self.problemsSummary = problemsSummary
        self.badgeApprovals = badgeApprovals
        self.badgeInvites = badgeInvites
        self.badgeInbox = badgeInbox
    }

    /// The value of one switch.
    public func isOn(_ switchValue: AccountNotificationSwitch) -> Bool {
        switch switchValue {
        case .approvals: approvals
        case .invites: invites
        case .reminders: reminders
        case .problemsSummary: problemsSummary
        case .badgeApprovals: badgeApprovals
        case .badgeInvites: badgeInvites
        case .badgeInbox: badgeInbox
        }
    }
}

public struct NotificationSettingsState: Equatable, Sendable {

    public var phase: NotificationSettingsPhase
    public var failure: FailureKind?
    public var choices: NotificationChoices?
    public var writeFailure: Failed?

    public init(
        phase: NotificationSettingsPhase = .loading,
        failure: FailureKind? = nil,
        choices: NotificationChoices? = nil,
        writeFailure: Failed? = nil
    ) {
        self.phase = phase
        self.failure = failure
        self.choices = choices
        self.writeFailure = writeFailure
    }
}

public enum NotificationSettingsAction: Equatable, Sendable {

    case retry
    case set(AccountNotificationSwitch, enabled: Bool)
    case setProblemsLevel(AccountProblemsLevel)
    case dismissFailure
}

/// The notification settings have no effects: a change is a state change.
public typealias NotificationSettingsScreenModel =
    ScreenModel<NotificationSettingsState, NotificationSettingsAction, Never>

/// Notification settings model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedNotificationSettingsScreenModel =
    ScriptedScreenModel<NotificationSettingsState, NotificationSettingsAction, Never>
