import CoreKit
import DesignSystem
import SwiftUI

/// What Semp pushes to the person and what counts on the app icon. A switch shows at once and is taken back when the
/// server refuses it. This screen only stores the preferences: it does not register the device for push.
struct NotificationSettingsScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: NotificationSettingsViewModel

    // MARK: - Init
    /// `viewModel` runs once per screen, when SwiftUI creates the state object.
    init(viewModel: @autoclosure @escaping () -> NotificationSettingsViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text("notifications.title", bundle: .module))
            .inlineNavigationTitle()
            .alert(
                Text("notifications.failed", bundle: .module),
                isPresented: Binding(
                    get: { viewModel.state.writeFailure != nil },
                    set: { _ in viewModel.dismissFailure() }
                )
            ) {
                Button(role: .cancel) {} label: { Text("common.ok", bundle: .module) }
            } message: {
                Text(FailureKind.message(for: viewModel.state.writeFailure?.kind))
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(AccountIdentifiers.notificationsScreen)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension NotificationSettingsScreen {

    @ViewBuilder var content: some View {
        switch (viewModel.state.phase, viewModel.state.choices) {
        case (.loading, _):
            StatusView(.loading)
        case (.error, _), (.content, nil):
            StatusView(
                .failure(message: Text(FailureKind.message(for: viewModel.state.failure)), retry: { viewModel.retry() })
            )
        case (.content, let choices?):
            form(choices)
        }
    }

    func form(_ choices: NotificationChoices) -> some View {
        Form {
            Section {
                toggle(.approvals, "notifications.approvals", "notifications.approvals.hint", choices)
                toggle(.invites, "notifications.invites", "notifications.invites.hint", choices)
                toggle(.reminders, "notifications.reminders", "notifications.reminders.hint", choices)
                Picker(selection: problemsLevel(choices)) {
                    ForEach(AccountProblemsLevel.allCases, id: \.self) { level in
                        Text(Self.levelName(level)).tag(level)
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("notifications.problems", bundle: .module)
                        Text(Self.levelHint(choices.problemsLevel))
                            .font(.footnote)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
                .accessibilityIdentifier(AccountIdentifiers.notificationProblems)
            } header: {
                Text("notifications.section.send", bundle: .module)
            } footer: {
                Text("notifications.hint", bundle: .module)
            }
            if choices.problemsLevel != .off {
                Section {
                    toggle(.problemsSummary, "notifications.summary", "notifications.summary.hint", choices)
                }
            }
            Section {
                toggle(.badgeApprovals, "notifications.badge.approvals", nil, choices)
                toggle(.badgeInvites, "notifications.badge.invites", nil, choices)
                toggle(.badgeInbox, "notifications.badge.inbox", nil, choices)
            } header: {
                Text("notifications.section.badge", bundle: .module)
            } footer: {
                Text("notifications.badge.hint", bundle: .module)
            }
        }
        .formStyle(.grouped)
    }

    func toggle(
        _ choice: AccountNotificationSwitch,
        _ title: LocalizedStringKey,
        _ hint: LocalizedStringKey?,
        _ choices: NotificationChoices
    ) -> some View {
        Toggle(
            isOn: Binding(get: { choices.isOn(choice) }, set: { viewModel.set(choice, enabled: $0) })
        ) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title, bundle: .module)
                if let hint {
                    Text(hint, bundle: .module).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                }
            }
        }
        .accessibilityIdentifier(AccountIdentifiers.notificationSwitchPrefix + Self.identifier(choice))
    }

    func problemsLevel(_ choices: NotificationChoices) -> Binding<AccountProblemsLevel> {
        Binding(get: { choices.problemsLevel }, set: { viewModel.setProblemsLevel($0) })
    }

    static func levelName(_ level: AccountProblemsLevel) -> String {
        switch level {
        case .off: String(localized: "notifications.level.off", bundle: .module)
        case .critical: String(localized: "notifications.level.critical", bundle: .module)
        case .all: String(localized: "notifications.level.all", bundle: .module)
        }
    }

    static func levelHint(_ level: AccountProblemsLevel) -> String {
        switch level {
        case .off: String(localized: "notifications.level.off.hint", bundle: .module)
        case .critical: String(localized: "notifications.level.critical.hint", bundle: .module)
        case .all: String(localized: "notifications.level.all.hint", bundle: .module)
        }
    }

    static func identifier(_ choice: AccountNotificationSwitch) -> String {
        switch choice {
        case .approvals: "approvals"
        case .invites: "invites"
        case .reminders: "reminders"
        case .problemsSummary: "problemsSummary"
        case .badgeApprovals: "badgeApprovals"
        case .badgeInvites: "badgeInvites"
        case .badgeInbox: "badgeInbox"
        }
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        NotificationSettingsScreen(
            viewModel: NotificationSettingsViewModel(
                model: ScriptedNotificationSettingsScreenModel(
                    state: NotificationSettingsState(phase: .content, choices: NotificationChoices())
                )
            )
        )
    }
}
