import SwiftUI

/// Screen-filling status of a screen without content: loading, nothing to show, or a failure the user can retry.
public struct StatusView: View {

    // MARK: - Status
    public enum Status {

        case loading
        /// Nothing to show, explained by `message` next to the SF Symbol `systemImage`.
        case empty(message: Text, systemImage: String)
        /// A failure explained by `message`, with a button that calls `retry`.
        case failure(message: Text, retry: @MainActor () -> Void)
    }

    // MARK: - Dependencies
    private let status: Status

    // MARK: - Init
    public init(_ status: Status) {
        self.status = status
    }

    // MARK: - Body
    public var body: some View {
        content
            .padding(Theme.Spacing.medium)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Subviews
private extension StatusView {

    @ViewBuilder var content: some View {
        switch status {
        case .loading:
            ProgressView { Text("state.loading", bundle: .module) }
                .accessibilityIdentifier(StatusIdentifiers.loading)
        case .empty(let message, let systemImage):
            ContentUnavailableView { label(message, systemImage: systemImage) }
        case .failure(let message, let retry):
            ContentUnavailableView {
                label(message, systemImage: "exclamationmark.triangle")
            } actions: {
                Button(action: retry) { Text("state.retry", bundle: .module) }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier(StatusIdentifiers.retry)
            }
        }
    }

    func label(_ message: Text, systemImage: String) -> some View {
        Label {
            message.accessibilityIdentifier(StatusIdentifiers.message)
        } icon: {
            Image(systemName: systemImage).foregroundStyle(Theme.Colors.accent)
        }
    }
}

// MARK: - Preview
// The features own the empty and failure messages, so their screens preview those statuses.
#Preview("Loading") {
    StatusView(.loading)
}
