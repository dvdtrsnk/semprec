import CoreKit
import DesignSystem
import SwiftUI

/// The "Set a new password" sheet a password-reset link opens: the new password twice, then a confirmation that
/// sends the person to the sign-in. The typed passwords stay in this view; the shared ViewModel gets them on every
/// change, to decide whether the form can be sent, and when it is sent. The sheet closes itself.
struct PasswordResetScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: PasswordResetViewModel
    @Environment(\.dismiss)
    private var dismiss

    // MARK: - State
    @State private var newPassword = ""
    @State private var repeated = ""

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> PasswordResetViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        NavigationStack {
            Form {
                if viewModel.state.isDone {
                    confirmation
                } else {
                    fields
                }
            }
            .formStyle(.grouped)
            .navigationTitle(Text("passwordReset.title", bundle: .module))
            .inlineNavigationTitle()
            .toolbar { toolbar }
        }
        .interactiveDismissDisabled(viewModel.state.isSending)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AuthIdentifiers.passwordResetScreen)
        .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension PasswordResetScreen {

    var fields: some View {
        Section {
            SecureField(text: $newPassword) { Text("passwordReset.newPassword", bundle: .module) }
                .textContentType(.newPassword)
                .onChange(of: newPassword) { edited() }
                .accessibilityIdentifier(AuthIdentifiers.passwordResetNewPassword)
            SecureField(text: $repeated) { Text("passwordReset.repeat", bundle: .module) }
                .textContentType(.newPassword)
                .onSubmit(submit)
                .onChange(of: repeated) { edited() }
                .accessibilityIdentifier(AuthIdentifiers.passwordResetRepeat)
        } footer: {
            if let message = viewModel.state.failureMessage {
                Text(message)
                    .foregroundStyle(Theme.Colors.destructive)
                    .accessibilityIdentifier(AuthIdentifiers.passwordResetMessage)
            }
        }
    }

    var confirmation: some View {
        Section {
            Label {
                Text("passwordReset.done", bundle: .module)
            } icon: {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.Colors.brand)
            }
            .accessibilityIdentifier(AuthIdentifiers.passwordResetDone)
        }
    }

    @ToolbarContentBuilder var toolbar: some ToolbarContent {
        if viewModel.state.isDone {
            ToolbarItem(placement: .confirmationAction) {
                Button { dismiss() } label: { Text("passwordReset.signIn", bundle: .module) }
                    .accessibilityIdentifier(AuthIdentifiers.passwordResetSignIn)
            }
        } else {
            PlainToolbarItem(placement: .cancellationAction) {
                Button { dismiss() } label: { Text("passwordReset.cancel", bundle: .module) }
                    .disabled(viewModel.state.isSending)
                    .accessibilityIdentifier(AuthIdentifiers.passwordResetCancel)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(action: submit) {
                    if viewModel.state.isSending {
                        ProgressView()
                    } else {
                        Text("passwordReset.submit", bundle: .module)
                    }
                }
                .disabled(!viewModel.state.canSubmit)
                .accessibilityIdentifier(AuthIdentifiers.passwordResetSubmit)
            }
        }
    }

    func edited() {
        viewModel.edited(newPassword: newPassword, repeated: repeated)
    }

    func submit() {
        viewModel.submit(newPassword: newPassword, repeated: repeated)
    }
}

// MARK: - Preview
#Preview("Editing") {
    PasswordResetScreen(
        viewModel: PasswordResetViewModel(model: ScriptedPasswordResetScreenModel(state: .editing(canSubmit: false)))
    )
}

#Preview("Expired link") {
    PasswordResetScreen(
        viewModel: PasswordResetViewModel(
            model: ScriptedPasswordResetScreenModel(state: .refused(.linkExpired, canSubmit: false))
        )
    )
}

#Preview("Done") {
    PasswordResetScreen(viewModel: PasswordResetViewModel(model: ScriptedPasswordResetScreenModel(state: .done)))
}
