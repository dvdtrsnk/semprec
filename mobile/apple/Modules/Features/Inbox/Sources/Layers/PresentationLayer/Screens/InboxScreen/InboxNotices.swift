import CoreKit
import DesignSystem
import SwiftUI

/// What an approval did, as a toast over the stack: it names the item that was created and opens it. It hides itself
/// after a few seconds.
struct InboxToastView: View {

    // MARK: - Dependencies
    let result: InboxResult
    let send: (InboxAction) -> Void

    // MARK: - Body
    var body: some View {
        Button {
            send(result.itemId == nil ? .dismissResult : .openResult)
        } label: {
            HStack(spacing: Theme.Spacing.small) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.Colors.accent)
                Text(message).lineLimit(1)
                if result.itemId != nil {
                    Text("inbox.toast.show", bundle: .module).bold().foregroundStyle(Theme.Colors.accent)
                }
            }
            .padding(.horizontal, Theme.Spacing.medium)
            .padding(.vertical, Theme.Spacing.small)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .capsule)
        .transition(.move(edge: .top).combined(with: .opacity))
        .task(id: result) {
            try? await Task.sleep(for: .seconds(Self.visibleSeconds))
            send(.dismissResult)
        }
        .accessibilityIdentifier(InboxIdentifiers.toast)
    }

    // MARK: - Private
    private static let visibleSeconds = 4

    private var message: String {
        String(format: String(localized: "inbox.toast.done", bundle: .module), locale: .current, result.label)
    }
}

/// A decision or a write that did not go through, as a banner over the stack.
struct InboxProblemView: View {

    // MARK: - Dependencies
    let problem: InboxProblem
    let failure: FailureKind?
    let send: (InboxAction) -> Void

    // MARK: - Body
    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.small) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.Colors.destructive)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).bold()
                Text(FailureKind.message(for: failure)).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
            }
            Spacer(minLength: 0)
            Button {
                send(.dismissProblem)
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("inbox.dismiss", bundle: .module))
        }
        .padding(Theme.Spacing.medium)
        .glassEffect(.regular, in: .rect(cornerRadius: Theme.Radius.card))
        .padding(.horizontal, Theme.Spacing.medium)
        .accessibilityIdentifier(InboxIdentifiers.problem)
    }

    // MARK: - Private
    private var title: String {
        switch problem {
        case .edit: String(localized: "inbox.problem.edit", bundle: .module)
        case .decision: String(localized: "inbox.problem.decision", bundle: .module)
        case .undo: String(localized: "inbox.problem.undo", bundle: .module)
        case .recompute: String(localized: "inbox.problem.recompute", bundle: .module)
        }
    }
}

/// The stack is empty: what was decided in this visit.
struct InboxEmptyView: View {

    // MARK: - Dependencies
    let handled: Int
    let dropped: Int

    // MARK: - Body
    var body: some View {
        ContentUnavailableView {
            Label { Text("inbox.empty.title", bundle: .module) } icon: {
                Image(systemName: "checkmark").foregroundStyle(.green)
            }
        } description: {
            Text(summary)
        }
        .accessibilityIdentifier(InboxIdentifiers.empty)
    }

    // MARK: - Private
    private var summary: String {
        String(
            format: String(localized: "inbox.empty.summary", bundle: .module),
            locale: .current,
            handled,
            dropped
        )
    }
}
