import CoreKit
import DesignSystem
import SwiftUI

/// Decides what a scene shows from the session of this device: a wait while the stored session is checked, the
/// sign-in form when there is none, a retry when the server cannot be reached, and the app once someone is signed in.
struct SessionGate<SignedIn: View, SignedOut: View>: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: SessionViewModel
    private let signedIn: () -> SignedIn
    private let signedOut: () -> SignedOut

    // MARK: - Init
    /// `viewModel` runs once per gate, when SwiftUI creates the state object.
    init(
        viewModel: @autoclosure @escaping () -> SessionViewModel,
        @ViewBuilder signedIn: @escaping () -> SignedIn,
        @ViewBuilder signedOut: @escaping () -> SignedOut
    ) {
        _viewModel = StateObject(wrappedValue: viewModel())
        self.signedIn = signedIn
        self.signedOut = signedOut
    }

    // MARK: - Body
    var body: some View {
        content
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(AppIdentifiers.sessionGate)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension SessionGate {

    @ViewBuilder var content: some View {
        switch viewModel.state {
        case .restoring:
            StatusView(.loading)
        case .unreachable:
            StatusView(.failure(message: Text("session.unreachable"), retry: { viewModel.retry() }))
        case .signedOut:
            signedOut()
        case .signedIn:
            signedIn()
        }
    }
}

// MARK: - Preview
#Preview("Restoring") {
    SessionGate(viewModel: SessionViewModel(model: ScriptedSessionScreenModel(state: .restoring))) {
        Text(verbatim: "Signed in")
    } signedOut: {
        Text(verbatim: "Signed out")
    }
}
