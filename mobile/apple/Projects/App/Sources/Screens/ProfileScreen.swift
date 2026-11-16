import CoreKit
import DesignSystem
import SwiftUI

/// The profile sheet that the profile button of the overview opens. It is the one place a later wave replaces with the
/// real profile and settings; until then it shows who is signed in where, and signs out, which no other screen offers.
struct ProfileScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: SessionViewModel
    @Environment(\.dismiss)
    private var dismiss

    // MARK: - Init
    /// `viewModel` runs once per sheet, when SwiftUI creates the state object.
    init(viewModel: @autoclosure @escaping () -> SessionViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        Form {
            if case .signedIn(let user) = viewModel.state {
                Section {
                    LabeledContent { Text(verbatim: user.email) } label: { Text("profile.email") }
                    LabeledContent { Text(verbatim: user.serverUrl) } label: { Text("profile.server") }
                }
            }
            Section {
                Button(role: .destructive) { viewModel.signOut() } label: { Text("profile.signOut") }
                    .accessibilityIdentifier(AppIdentifiers.profileSignOut)
            }
        }
        .formStyle(.grouped)
        .navigationTitle(Text("profile.title"))
        .inlineNavigationTitle()
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button { dismiss() } label: { Text("profile.done") }
                    .accessibilityIdentifier(AppIdentifiers.profileDone)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AppIdentifiers.profileScreen)
        .task { await viewModel.observe() }
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        ProfileScreen(
            viewModel: SessionViewModel(
                model: ScriptedSessionScreenModel(
                    state: .signedIn(SessionUser(email: "a@b.cz", role: "member", serverUrl: "https://s.example"))
                )
            )
        )
    }
}
