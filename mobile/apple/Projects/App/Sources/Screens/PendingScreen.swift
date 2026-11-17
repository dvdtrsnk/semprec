import DesignSystem
import SwiftUI

/// Stands in for a screen that a later wave of the app builds, so that a link to it is not a dead end.
struct PendingScreen: View {

    // MARK: - Dependencies
    let title: String

    // MARK: - Body
    var body: some View {
        StatusView(.empty(message: Text("pending.message"), systemImage: "hammer"))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(AppIdentifiers.pendingScreen)
            .navigationTitle(title)
            .inlineNavigationTitle()
    }
}

// MARK: - Preview
#Preview {
    NavigationStack { PendingScreen(title: "Inbox") }
}
