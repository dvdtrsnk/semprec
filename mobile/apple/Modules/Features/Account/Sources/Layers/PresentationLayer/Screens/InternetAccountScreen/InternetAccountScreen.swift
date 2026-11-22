import CoreKit
import DesignSystem
import SwiftUI

/// One internet account: a switch per service (Mail and Calendars) with what each is doing, a calendar sync on
/// request, its name and the number of connections the server may open, what Semp may do with its mail, and its
/// removal, which says what it would hide before it asks. Switching a service off asks first, because it removes what
/// the service synced. A Google or Microsoft account signs in again, and allows calendar access, in a browser started
/// here; an iCloud or another password account signs in again in a sheet that asks for its password. An account the
/// app cannot sign in again is told to do so on the web.
struct InternetAccountScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: InternetAccountViewModel

    // MARK: - State
    @Environment(\.dismiss)
    private var dismiss
    @Environment(\.webAuthenticationSession)
    private var webAuthenticationSession
    @State private var name = ""
    @State private var seededFor: String?

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> InternetAccountViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text(verbatim: viewModel.state.account?.name ?? ""))
            .inlineNavigationTitle()
            .alert(
                Text("profile.failed.title", bundle: .module),
                isPresented: actionFailed,
                actions: { dismissButton },
                message: { Text("internetAccount.failure", bundle: .module) }
            )
            .alert(
                Text("profile.failed.title", bundle: .module),
                isPresented: signInFailed,
                actions: { dismissButton },
                message: { Text(viewModel.state.signInFailure?.message ?? "") }
            )
            .confirmationDialog(
                Text(offTitle, bundle: .module),
                isPresented: confirmingOff,
                titleVisibility: .visible,
                actions: {
                    Button(role: .destructive) { viewModel.send(.confirmServiceOff) } label: {
                        Text("internetAccount.off.confirm", bundle: .module)
                    }
                    .accessibilityIdentifier(AccountIdentifiers.internetAccountConfirmOff)
                    Button(role: .cancel) { viewModel.send(.cancelServiceOff) } label: {
                        Text("internetAccount.off.cancel", bundle: .module)
                    }
                },
                message: { Text(offMessage, bundle: .module) }
            )
            .confirmationDialog(
                Text("internetAccount.remove.title", bundle: .module),
                isPresented: confirmingRemoval,
                titleVisibility: .visible,
                actions: {
                    Button(role: .destructive) { viewModel.send(.confirmRemoval) } label: {
                        Text("internetAccount.remove.confirm", bundle: .module)
                    }
                    .accessibilityIdentifier(AccountIdentifiers.internetAccountConfirmRemove)
                    Button(role: .cancel) { viewModel.send(.cancelRemoval) } label: {
                        Text("internetAccount.remove.cancel", bundle: .module)
                    }
                },
                message: { Text(verbatim: impactText) }
            )
            .sheet(isPresented: passwordSignInShown) {
                if let signIn = viewModel.state.passwordSignIn {
                    PasswordSignInSheet(signIn: signIn) { viewModel.send(.passwordSignIn($0)) }
                }
            }
            .onChange(of: viewModel.closeRequests) { dismiss() }
            .onChange(of: viewModel.state.account?.name, initial: true) { _, new in
                if let new, seededFor != new { name = new; seededFor = new }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(AccountIdentifiers.internetAccountScreen)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension InternetAccountScreen {

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

    func details(_ account: InternetAccountDetail) -> some View {
        List {
            Section { header(account) }.listRowBackground(Color.clear)
            services(account)
            if account.mail == .needsReauthorization || account.canSignInAgain { reauthorization(account) }
            Section {
                TextField(text: $name) { Text("internetAccount.name", bundle: .module) }
                    .onSubmit { viewModel.send(.rename(name)) }
                    .accessibilityIdentifier(AccountIdentifiers.internetAccountName)
            }
            if account.mailEnabled { mail(account) }
            Section {
                Button(role: .destructive) { viewModel.send(.requestRemoval) } label: {
                    HStack {
                        Text("internetAccount.remove", bundle: .module)
                        if viewModel.state.removal == .loadingImpact || viewModel.state.removal == .removing {
                            ProgressView()
                        }
                    }
                }
                .disabled(viewModel.state.removal != .idle)
                .accessibilityIdentifier(AccountIdentifiers.internetAccountRemove)
            }
        }
        .groupedListStyle()
    }

    func header(_ account: InternetAccountDetail) -> some View {
        VStack(spacing: Theme.Spacing.small) {
            InternetAccountProviderBadge(provider: account.provider, size: 64)
            Text(verbatim: account.name).font(.title2.weight(.semibold))
            if let address = account.address {
                Text(verbatim: address).font(.subheadline).foregroundStyle(Theme.Colors.secondaryText)
            }
        }
        .frame(maxWidth: .infinity)
    }

    func services(_ account: InternetAccountDetail) -> some View {
        Section {
            service(.mail, enabled: account.mailEnabled, status: account.mail)
                .accessibilityIdentifier(AccountIdentifiers.internetAccountMail)
            service(.calendars, enabled: account.calendarsEnabled, status: account.calendars)
                .accessibilityIdentifier(AccountIdentifiers.internetAccountCalendars)
            if account.calendars == .needsConsent {
                notice("internetAccount.consent")
                if account.canAllowCalendarAccess {
                    signInButton("internetAccount.allowCalendars") {
                        viewModel.allowCalendarAccess(browser: BrowserSignIn(webAuthenticationSession))
                    }
                    .accessibilityIdentifier(AccountIdentifiers.internetAccountAllowCalendars)
                }
            } else if account.calendars == .error {
                notice("internetAccount.calendarError")
            }
            if account.calendarsEnabled {
                Button { viewModel.send(.syncNow) } label: {
                    HStack {
                        Text("internetAccount.syncNow", bundle: .module)
                        if viewModel.state.syncRequested { ProgressView() }
                    }
                }
                .disabled(viewModel.state.syncRequested)
                .accessibilityIdentifier(AccountIdentifiers.internetAccountSyncNow)
            }
        } header: {
            Text("internetAccount.services", bundle: .module)
        } footer: {
            Text("internetAccount.services.footer", bundle: .module)
        }
    }

    func service(_ service: InternetAccountService, enabled: Bool, status: InternetServiceStatus) -> some View {
        Toggle(isOn: serviceSwitch(service, enabled: enabled)) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: InternetServiceStatusLabel.name(service))
                InternetServiceStatusLabel(service: service, status: status, named: false)
            }
        }
    }

    func notice(_ text: LocalizedStringKey) -> some View {
        Label {
            Text(text, bundle: .module).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        }
    }

    func reauthorization(_ account: InternetAccountDetail) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Label {
                    Text("internetAccount.reauth.title", bundle: .module).font(.subheadline.weight(.semibold))
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                }
                Text(verbatim: reauthorizationText(account)).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
            }
            if account.canSignInAgain {
                signInButton("internetAccount.signInAgain") {
                    viewModel.signInAgain(browser: BrowserSignIn(webAuthenticationSession))
                }
                .accessibilityIdentifier(AccountIdentifiers.internetAccountSignInAgain)
            }
        }
    }

    func signInButton(_ title: LocalizedStringKey, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title, bundle: .module)
                if viewModel.state.signingIn { ProgressView() }
            }
        }
        .disabled(viewModel.state.signingIn)
    }

    @ViewBuilder
    func mail(_ account: InternetAccountDetail) -> some View {
        Section {
            row("internetAccount.sync", Text(verbatim: syncModeText(account.syncMode)))
            row("internetAccount.last", Text(verbatim: lastActivity(account)))
            if let downloaded = account.syncedMessageCount {
                row("internetAccount.downloaded", Text(downloaded, format: .number))
            }
            if account.connectionLimitApplies { connections(account) }
        } header: {
            Text("internetAccount.mail", bundle: .module)
        }
        Section {
            row("internetAccount.draftsRow", Text("internetAccount.always", bundle: .module))
            row("internetAccount.autoSend", Text(verbatim: autoSendText(account.autonomousSendProjectCount)))
        } header: {
            Text("internetAccount.semp", bundle: .module)
        } footer: {
            Text("internetAccount.autoSend.footer", bundle: .module)
        }
    }

    func connections(_ account: InternetAccountDetail) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("internetAccount.connections", bundle: .module)
                Text("internetAccount.connections.hint", bundle: .module)
                    .font(.footnote)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            Spacer(minLength: 0)
            Text(verbatim: String(account.connectionLimit)).monospacedDigit()
            Stepper(value: connectionLimit(account), in: 1...15) { EmptyView() }
                .labelsHidden()
                .accessibilityLabel(Text("internetAccount.connections", bundle: .module))
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
private extension InternetAccountScreen {

    var dismissButton: some View {
        Button(role: .cancel) { viewModel.send(.dismissFailure) } label: { Text("common.ok", bundle: .module) }
    }

    var actionFailed: Binding<Bool> {
        Binding(get: { viewModel.state.actionFailed }, set: { if !$0 { viewModel.send(.dismissFailure) } })
    }

    var passwordSignInShown: Binding<Bool> {
        Binding(
            get: { viewModel.state.passwordSignIn != nil },
            set: { if !$0, viewModel.state.passwordSignIn != nil { viewModel.send(.passwordSignIn(.cancel)) } }
        )
    }

    var signInFailed: Binding<Bool> {
        Binding(get: { viewModel.state.signInFailure != nil }, set: { if !$0 { viewModel.send(.dismissFailure) } })
    }

    var confirmingOff: Binding<Bool> {
        Binding(
            get: { viewModel.state.confirmingOff != nil },
            set: { if !$0, viewModel.state.confirmingOff != nil { viewModel.send(.cancelServiceOff) } }
        )
    }

    var confirmingRemoval: Binding<Bool> {
        Binding(
            get: { viewModel.state.removal == .confirming },
            set: { if !$0, viewModel.state.removal == .confirming { viewModel.send(.cancelRemoval) } }
        )
    }

    var offTitle: LocalizedStringKey {
        viewModel.state.confirmingOff == .mail
            ? "internetAccount.off.mail.title"
            : "internetAccount.off.calendars.title"
    }

    var offMessage: LocalizedStringKey {
        viewModel.state.confirmingOff == .mail
            ? "internetAccount.off.mail.message"
            : "internetAccount.off.calendars.message"
    }

    /// A switch over a service: the shared ViewModel decides whether the change is written at once or asked first,
    /// so the binding only reports what the person did.
    func serviceSwitch(_ service: InternetAccountService, enabled: Bool) -> Binding<Bool> {
        Binding(get: { enabled }, set: { viewModel.send(.setService(service, enabled: $0)) })
    }

    /// A stepper over the limit: the shared ViewModel clamps and writes it, so the binding only reports the step.
    func connectionLimit(_ account: InternetAccountDetail) -> Binding<Int> {
        Binding(
            get: { account.connectionLimit },
            set: { viewModel.send(.stepConnectionLimit(delta: $0 - account.connectionLimit)) }
        )
    }

    var impactText: String {
        guard let impact = viewModel.state.impact else { return "" }
        let format = String(localized: "internetAccount.remove.impact", bundle: .module)
        let counts = [impact.messages, impact.drafts, impact.threads, impact.attachmentsKept]
        return String(format: format, locale: .current, arguments: counts)
    }

    func syncModeText(_ mode: String) -> String {
        switch mode {
        case "gmail_api": String(localized: "internetAccount.mode.gmail", bundle: .module)
        case "graph_api": String(localized: "internetAccount.mode.graph", bundle: .module)
        case "imap": String(localized: "internetAccount.mode.imap", bundle: .module)
        default: mode
        }
    }

    func lastActivity(_ account: InternetAccountDetail) -> String {
        AccountFormat.syncTime(account.lastSuccessfulSyncAt)
            ?? String(localized: "internetAccount.never", bundle: .module)
    }

    func reauthorizationText(_ account: InternetAccountDetail) -> String {
        if account.canSignInAgain { return String(localized: "internetAccount.reauth.signIn", bundle: .module) }
        guard let since = AccountFormat.syncTime(account.failingSince) else {
            return String(localized: "internetAccount.reauth.text", bundle: .module)
        }
        let format = String(localized: "internetAccount.reauth.since", bundle: .module)
        return String(format: format, locale: .current, since)
    }

    func autoSendText(_ count: Int) -> String {
        String(format: String(localized: "internetAccount.autoSend.count", bundle: .module), locale: .current, count)
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        InternetAccountScreen(
            viewModel: InternetAccountViewModel(
                model: ScriptedInternetAccountScreenModel(
                    state: InternetAccountState(
                        phase: .content,
                        account: InternetAccountDetail(
                            id: "a1", name: "iCloud", address: "david@icloud.com", provider: "icloud",
                            syncMode: "imap", mailEnabled: true, calendarsEnabled: true, mail: .ok,
                            calendars: .pending, lastSuccessfulSyncAt: "2026-11-20T08:12:00Z", failingSince: nil,
                            connectionLimit: 3, connectionLimitApplies: true, autonomousSendProjectCount: 1
                        )
                    )
                ),
                router: PreviewAccountRouter()
            )
        )
    }
}
