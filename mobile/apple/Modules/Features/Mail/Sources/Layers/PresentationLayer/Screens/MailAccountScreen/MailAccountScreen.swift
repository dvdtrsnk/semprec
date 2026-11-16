import CoreKit
import DesignSystem
import SwiftUI

/// One account: what its sync is doing, its name and the number of connections the server may open (which the person
/// may change), what Semp may do with it, and its removal, which says what it would hide before it asks. A mailbox that
/// needs signing in again says so; signing in is done in a browser, which this app does not start.
struct MailAccountScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: MailAccountViewModel

    // MARK: - State
    @Environment(\.dismiss)
    private var dismiss
    @State private var name = ""
    @State private var seededFor: String?

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> MailAccountViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text(verbatim: viewModel.state.account?.name ?? ""))
            .inlineNavigationTitle()
            .alert(
                Text("mail.failure.title", bundle: .module),
                isPresented: actionFailed,
                actions: { dismissButton },
                message: { Text("mail.account.failure", bundle: .module) }
            )
            .confirmationDialog(
                Text("mail.account.remove.title", bundle: .module),
                isPresented: confirming,
                titleVisibility: .visible,
                actions: {
                    Button(role: .destructive) { viewModel.send(.confirmRemoval) } label: {
                        Text("mail.account.remove.confirm", bundle: .module)
                    }
                    .accessibilityIdentifier(MailIdentifiers.accountConfirmRemove)
                    Button(role: .cancel) { viewModel.send(.cancelRemoval) } label: {
                        Text("mail.account.remove.cancel", bundle: .module)
                    }
                },
                message: { Text(verbatim: impactText) }
            )
            .onChange(of: viewModel.closeRequests) { dismiss() }
            .onChange(of: viewModel.state.account?.name, initial: true) { _, new in
                if let new, seededFor != new { name = new; seededFor = new }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(MailIdentifiers.accountScreen)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension MailAccountScreen {

    @ViewBuilder var content: some View {
        switch viewModel.state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.message(for: failure)), retry: { viewModel.send(.retry) }))
        case .content:
            if let account = viewModel.state.account { details(account) } else { StatusView(.loading) }
        }
    }

    func details(_ account: MailAccountDetail) -> some View {
        List {
            Section { header(account) }.listRowBackground(Color.clear)
            if account.status == .needsReauthorization { reauthorization(account) }
            Section {
                TextField(text: $name) { Text("mail.account.name", bundle: .module) }
                    .onSubmit { viewModel.send(.rename(name)) }
                    .accessibilityIdentifier(MailIdentifiers.accountName)
                row("mail.account.sync", Text(verbatim: syncModeText(account.syncMode)))
                row("mail.account.last", Text(verbatim: lastActivity(account)))
                if account.connectionLimitApplies { connections(account) }
            }
            Section {
                row("mail.account.draftsRow", Text("mail.account.always", bundle: .module))
                row("mail.account.autoSend", Text(verbatim: autoSendText(account.autonomousSendProjectCount)))
            } header: {
                Text("mail.account.semp", bundle: .module)
            } footer: {
                Text("mail.account.autoSend.footer", bundle: .module)
            }
            Section {
                Button(role: .destructive) { viewModel.send(.requestRemoval) } label: {
                    HStack {
                        Text("mail.account.remove", bundle: .module)
                        if viewModel.state.removal == .loadingImpact || viewModel.state.removal == .removing {
                            ProgressView()
                        }
                    }
                }
                .disabled(viewModel.state.removal != .idle)
                .accessibilityIdentifier(MailIdentifiers.accountRemove)
            }
        }
        .groupedListStyle()
    }

    func header(_ account: MailAccountDetail) -> some View {
        VStack(spacing: Theme.Spacing.small) {
            MailProviderBadge(provider: account.provider, size: 64)
            Text(verbatim: account.name).font(.title2.weight(.semibold))
            if let address = account.address {
                Text(verbatim: address).font(.subheadline).foregroundStyle(Theme.Colors.secondaryText)
            }
            MailStatusLabel(status: account.status)
        }
        .frame(maxWidth: .infinity)
    }

    func reauthorization(_ account: MailAccountDetail) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Label {
                    Text("mail.account.reauth.title", bundle: .module).font(.subheadline.weight(.semibold))
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                }
                Text(verbatim: reauthorizationText(account)).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
            }
        }
    }

    func connections(_ account: MailAccountDetail) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("mail.account.connections", bundle: .module)
                Text("mail.account.connections.hint", bundle: .module)
                    .font(.footnote)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            Spacer(minLength: 0)
            Text(verbatim: String(account.connectionLimit)).monospacedDigit()
            Stepper(
                value: connectionLimit(account),
                in: 1...15
            ) { EmptyView() }
            .labelsHidden()
            .accessibilityLabel(Text("mail.account.connections", bundle: .module))
            .accessibilityValue(Text(verbatim: String(account.connectionLimit)))
        }
    }

    func row(_ title: LocalizedStringKey, _ value: Text) -> some View {
        HStack {
            Text(title, bundle: .module)
            Spacer(minLength: 0)
            value.foregroundStyle(Theme.Colors.secondaryText)
        }
    }
}

// MARK: - Private
private extension MailAccountScreen {

    var dismissButton: some View {
        Button(role: .cancel) { viewModel.send(.dismissFailure) } label: { Text("state.ok", bundle: .module) }
    }

    var actionFailed: Binding<Bool> {
        Binding(get: { viewModel.state.actionFailed }, set: { if !$0 { viewModel.send(.dismissFailure) } })
    }

    var confirming: Binding<Bool> {
        Binding(
            get: { viewModel.state.removal == .confirming },
            set: { if !$0, viewModel.state.removal == .confirming { viewModel.send(.cancelRemoval) } }
        )
    }

    /// A stepper over the limit: the shared ViewModel clamps and writes it, so the binding only reports the step.
    func connectionLimit(_ account: MailAccountDetail) -> Binding<Int> {
        Binding(
            get: { account.connectionLimit },
            set: { viewModel.send(.stepConnectionLimit(delta: $0 - account.connectionLimit)) }
        )
    }

    var impactText: String {
        guard let impact = viewModel.state.impact else { return "" }
        let format = String(localized: "mail.account.remove.impact", bundle: .module)
        let counts = [impact.messages, impact.drafts, impact.threads, impact.attachmentsKept]
        return String(format: format, locale: .current, arguments: counts)
    }

    func syncModeText(_ mode: String) -> String {
        switch mode {
        case "gmail_api": String(localized: "mail.account.mode.gmail", bundle: .module)
        case "graph_api": String(localized: "mail.account.mode.graph", bundle: .module)
        case "imap": String(localized: "mail.account.mode.imap", bundle: .module)
        default: mode
        }
    }

    func lastActivity(_ account: MailAccountDetail) -> String {
        let never = String(localized: "mail.account.never", bundle: .module)
        return MailFormatting.syncTime(account.lastSuccessfulSyncAt) ?? never
    }

    func reauthorizationText(_ account: MailAccountDetail) -> String {
        guard let since = MailFormatting.syncTime(account.failingSince) else {
            return String(localized: "mail.account.reauth.text", bundle: .module)
        }
        let format = String(localized: "mail.account.reauth.since", bundle: .module)
        return String(format: format, locale: .current, since)
    }

    func autoSendText(_ count: Int) -> String {
        String(format: String(localized: "mail.account.autoSend.count", bundle: .module), locale: .current, count)
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        MailAccountScreen(
            viewModel: MailAccountViewModel(model: ScriptedMailAccountScreenModel(state: PreviewMail.account))
        )
    }
}
