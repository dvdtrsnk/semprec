import CoreKit
import DesignSystem
import SwiftUI

/// Writing a message: the recipients (people the person knows are suggested while typing), the account it is sent
/// from, the subject and the text. The subject and the text stay in this view and go to the shared ViewModel when the
/// message is sent; the app presents the screen as a sheet.
struct MailComposeScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: MailComposeViewModel

    // MARK: - State
    @Environment(\.dismiss)
    private var dismiss
    @State private var recipient = ""
    @State private var subject = ""
    @State private var text = ""
    @State private var seeded = false

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> MailComposeViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        NavigationStack {
            content
                .navigationTitle(Text(verbatim: title))
                .inlineNavigationTitle()
                .toolbar {
                    PlainToolbarItem(placement: .cancellationAction) {
                        Button { viewModel.send(.cancel) } label: {
                            Label { Text("mail.compose.cancel", bundle: .module) } icon: { Image(systemName: "xmark") }
                        }
                        .accessibilityIdentifier(MailIdentifiers.composeCancel)
                    }
                    ToolbarItem(placement: .confirmationAction) { sendButton }
                }
        }
        .onChange(of: viewModel.closeRequests) { dismiss() }
        .onChange(of: viewModel.state.phase, initial: true) { _, phase in
            guard phase == .editing, !seeded else { return }
            subject = viewModel.state.initialSubject
            text = viewModel.state.initialBody
            seeded = true
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(MailIdentifiers.composeScreen)
        .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension MailComposeScreen {

    @ViewBuilder var content: some View {
        switch viewModel.state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let failure):
            StatusView(
                .failure(
                    message: Text(FailureKind.message(for: failure, refusal: viewModel.state.refusal)),
                    retry: { viewModel.send(.retry) }
                )
            )
        case .editing:
            form
        }
    }

    var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                recipients
                Divider()
                sender
                Divider()
                subjectField
                Divider()
                textEditor
                status
            }
            .padding(.horizontal, Theme.Spacing.medium)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    var recipients: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.small) {
                Text("mail.compose.to", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
                FlowChips(recipients: viewModel.state.toRecipients + viewModel.state.ccRecipients) { address in
                    viewModel.send(.removeRecipient(address: address))
                }
                TextField(text: $recipient) { Text("mail.compose.to.prompt", bundle: .module) }
                    .textInput(.email)
                    .onSubmit { addTyped() }
                    .onChange(of: recipient) { _, new in viewModel.send(.searchContacts(new)) }
                    .accessibilityIdentifier(MailIdentifiers.composeTo)
            }
            .padding(.vertical, Theme.Spacing.small + 4)
            if viewModel.state.invalidAddress {
                Text("mail.compose.to.invalid", bundle: .module)
                    .font(.footnote)
                    .foregroundStyle(Theme.Colors.destructive)
            }
            ForEach(viewModel.state.suggestions) { person in suggestion(person) }
        }
    }

    func suggestion(_ person: MailSuggestion) -> some View {
        Button {
            viewModel.send(.addRecipient(name: person.name, address: person.address))
            recipient = ""
        } label: {
            HStack(spacing: Theme.Spacing.small + 4) {
                MailAvatar(name: person.name, address: person.address, size: 30)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: person.name.isEmpty ? person.address : person.name).foregroundStyle(.primary)
                    Text(verbatim: details(person))
                        .font(.footnote)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    var sender: some View {
        HStack {
            Text("mail.compose.from", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
            Picker(selection: senderSelection) {
                ForEach(viewModel.state.senders) { sender in
                    Text(verbatim: sender.address).tag(Optional(sender.mailboxId))
                }
            } label: {
                Text("mail.compose.from", bundle: .module)
            }
            .labelsHidden()
            .accessibilityIdentifier(MailIdentifiers.composeSender)
            Spacer(minLength: 0)
        }
        .padding(.vertical, Theme.Spacing.small)
    }

    var subjectField: some View {
        HStack {
            Text("mail.compose.subject", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
            TextField(text: $subject) { Text("mail.compose.subject", bundle: .module) }
                .accessibilityIdentifier(MailIdentifiers.composeSubject)
        }
        .padding(.vertical, Theme.Spacing.small + 4)
    }

    var textEditor: some View {
        TextEditor(text: $text)
            .frame(minHeight: 260)
            .scrollContentBackground(.hidden)
            .accessibilityLabel(Text("mail.compose.body", bundle: .module))
            .accessibilityIdentifier(MailIdentifiers.composeBody)
    }

    @ViewBuilder var status: some View {
        let state = viewModel.state
        if state.sendPhase == .sent, let account = state.sentFrom {
            Label {
                Text(verbatim: sentText(account))
            } icon: {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            }
        } else if state.sendPhase == .failed {
            Text(FailureKind.sendMessage(for: state.sendFailure, refusal: state.sendRefusal))
                .foregroundStyle(Theme.Colors.destructive)
        } else if state.discardFailed {
            Text("mail.compose.discardFailed", bundle: .module).foregroundStyle(Theme.Colors.destructive)
        }
    }

    func details(_ person: MailSuggestion) -> String {
        [person.address, person.relationship].compactMap(\.self).joined(separator: " \u{00B7} ")
    }

    func sentText(_ account: String) -> String {
        String(format: String(localized: "mail.compose.sent", bundle: .module), locale: .current, account)
    }

    var sendButton: some View {
        Button { viewModel.send(.send(subject: subject, body: text)) } label: {
            Label {
                Text("mail.compose.send", bundle: .module)
            } icon: {
                Image(systemName: viewModel.state.sendPhase == .sending ? "hourglass" : "arrow.up")
            }
        }
        .buttonStyle(.borderedProminent)
        .disabled(!canSend)
        .accessibilityIdentifier(MailIdentifiers.composeSend)
    }
}

// MARK: - Private
private extension MailComposeScreen {

    var title: String {
        let trimmed = subject.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? String(localized: "mail.compose.title", bundle: .module) : trimmed
    }

    var canSend: Bool {
        let state = viewModel.state
        let idle = state.sendPhase != .sending && state.sendPhase != .sent
        return state.phase == .editing && !state.toRecipients.isEmpty && idle
    }

    var senderSelection: Binding<String?> {
        Binding(
            get: { viewModel.state.senderId },
            set: { if let id = $0 { viewModel.send(.selectSender(mailboxId: id)) } }
        )
    }

    func addTyped() {
        let typed = recipient.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty else { return }
        viewModel.send(.addAddress(typed))
        recipient = ""
    }
}

/// The recipients so far as removable capsules next to the field that adds another.
private struct FlowChips: View {

    // MARK: - Dependencies
    let recipients: [MailRecipient]
    let remove: (String) -> Void

    // MARK: - Body
    var body: some View {
        ForEach(recipients) { person in
            Button { remove(person.address) } label: {
                HStack(spacing: 4) {
                    Text(verbatim: person.name.isEmpty ? person.address : person.name).font(.subheadline)
                    Image(systemName: "xmark.circle.fill").font(.caption).foregroundStyle(Theme.Colors.secondaryText)
                }
                .padding(.horizontal, Theme.Spacing.small)
                .padding(.vertical, 4)
                .background(Theme.Colors.accent.opacity(0.12), in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(verbatim: removeLabel(person)))
        }
    }

    private func removeLabel(_ person: MailRecipient) -> String {
        let name = person.name.isEmpty ? person.address : person.name
        return String(format: String(localized: "mail.compose.to.remove", bundle: .module), locale: .current, name)
    }
}

// MARK: - Preview
#Preview {
    MailComposeScreen(
        viewModel: MailComposeViewModel(model: ScriptedMailComposeScreenModel(state: PreviewMail.compose))
    )
}
