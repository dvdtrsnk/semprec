import SwiftUI

/// The detail of an item as a sheet: a navigation stack of its own around the item screen and the system close button.
struct ItemSheet<Content: View>: View {

    // MARK: - Dependencies
    @ViewBuilder let content: () -> Content
    @Environment(\.dismiss)
    private var dismiss

    // MARK: - Body
    var body: some View {
        NavigationStack {
            content()
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(role: .close) { dismiss() }
                            .accessibilityIdentifier(CollectionsIdentifiers.closeItem)
                    }
                }
        }
    }
}
