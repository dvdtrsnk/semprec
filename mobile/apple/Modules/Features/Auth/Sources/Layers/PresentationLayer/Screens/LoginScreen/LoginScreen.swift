import CoreKit
import DesignSystem
import SwiftUI

/// The sign-in form: server, e-mail and password. The typed text stays in this view; the shared ViewModel gets it
/// only when the person signs in or asks for a password reset.
struct LoginScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: LoginViewModel

    // MARK: - State
    @AppStorage("cz.semprec.lastServer")
    private var server = ""
    @State private var email = ""
    @State private var password = ""
    @FocusState private var focus: Field?

    fileprivate enum Field { case server, email, password }

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> LoginViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Spacing.large) {
                header
                form
                notice
                signInButton
                forgotButton
            }
            .padding(.horizontal, Theme.Spacing.medium)
            .padding(.top, Theme.Spacing.hero)
            .onAppear { if server.isEmpty { server = Self.defaultServer } }
            .frame(maxWidth: Theme.Layout.formWidth)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.Colors.groupedBackground)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AuthIdentifiers.loginScreen)
        .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension LoginScreen {

    var header: some View {
        VStack(spacing: Theme.Spacing.small) {
            Image(systemName: "bubble.left")
                .font(.system(size: 36, weight: .regular))
                .foregroundStyle(.background)
                .frame(width: 76, height: 76)
                .background(Theme.Colors.brand, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .accessibilityHidden(true)
            Text("Semprec").font(.largeTitle.bold())
            Text("login.subtitle", bundle: .module).font(.subheadline).foregroundStyle(Theme.Colors.secondaryText)
        }
    }

    var form: some View {
        VStack(spacing: 0) {
            row("login.server", text: $server, field: .server, kind: .url, id: AuthIdentifiers.server)
            Divider().padding(.leading, Theme.Spacing.medium)
            row("login.email", text: $email, field: .email, kind: .email, id: AuthIdentifiers.email)
            Divider().padding(.leading, Theme.Spacing.medium)
            passwordRow
        }
        .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
    }

    func row(
        _ title: LocalizedStringKey,
        text: Binding<String>,
        field: Field,
        kind: TextInputKind,
        id: String
    ) -> some View {
        HStack(spacing: Theme.Spacing.medium) {
            Text(title, bundle: .module).frame(width: 76, alignment: .leading)
            TextField("", text: text)
                .textInput(kind)
                .focused($focus, equals: field)
                .submitLabel(.next)
                .onSubmit { focus = field == .server ? .email : .password }
                .onChange(of: text.wrappedValue) { viewModel.edited() }
                .accessibilityIdentifier(id)
        }
        .padding(.horizontal, Theme.Spacing.medium)
        .frame(minHeight: Theme.Layout.rowHeight)
    }

    var passwordRow: some View {
        HStack(spacing: Theme.Spacing.medium) {
            Text("login.password", bundle: .module).frame(width: 76, alignment: .leading)
            SecureField(text: $password) { Text("login.password.placeholder", bundle: .module) }
                .textContentType(.password)
                .focused($focus, equals: .password)
                .submitLabel(.go)
                .onSubmit(signIn)
                .onChange(of: password) { viewModel.edited() }
                .accessibilityIdentifier(AuthIdentifiers.password)
        }
        .padding(.horizontal, Theme.Spacing.medium)
        .frame(minHeight: Theme.Layout.rowHeight)
    }

    @ViewBuilder var notice: some View {
        if let message = viewModel.state.message {
            Text(message)
                .font(.subheadline)
                .foregroundStyle(viewModel.state.isFailure ? Theme.Colors.destructive : Theme.Colors.secondaryText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Theme.Spacing.medium)
                .accessibilityIdentifier(AuthIdentifiers.message)
        }
    }

    var signInButton: some View {
        Button(action: signIn) {
            HStack(spacing: Theme.Spacing.small) {
                if viewModel.state.isSigningIn { ProgressView() }
                Text(viewModel.state.isSigningIn ? "login.signingIn" : "login.signIn", bundle: .module)
                    .font(.headline)
            }
            .foregroundStyle(.background)
            .frame(maxWidth: .infinity, minHeight: Theme.Layout.buttonHeight)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.capsule)
        .tint(Theme.Colors.brand)
        .disabled(viewModel.state.isSigningIn)
        .accessibilityIdentifier(AuthIdentifiers.signIn)
    }

    var forgotButton: some View {
        Button { viewModel.forgotPassword(server: server, email: email) } label: {
            Text("login.forgot", bundle: .module)
        }
        .disabled(viewModel.state.isSigningIn)
        .accessibilityIdentifier(AuthIdentifiers.forgot)
    }

    func signIn() {
        viewModel.signIn(server: server, email: email, password: password)
    }
}

// MARK: - Preview
#Preview("Login") {
    LoginScreen(viewModel: LoginViewModel(model: ScriptedLoginScreenModel(state: .editing(resetRequested: false))))
}

#Preview("Failed") {
    LoginScreen(viewModel: LoginViewModel(model: ScriptedLoginScreenModel(state: .failed(.unauthorized))))
}

// MARK: - Default server
private extension LoginScreen {

    /// The server the app was built for (`SemprecDefaultServer` in the app's Info.plist), offered while the person
    /// has not signed in to any other one; empty when the build names none.
    static var defaultServer: String {
        Bundle.main.object(forInfoDictionaryKey: "SemprecDefaultServer") as? String ?? ""
    }
}
