import CoreKit
import DesignSystem
import SwiftUI

/// One row of the overview list: a colored tile with a symbol, a title with an optional second line, what the row
/// counts, and the target it opens.
struct OverviewRow: Identifiable {

    // MARK: - Trailing
    enum Trailing: Equatable {

        case none
        /// A plain count, as the number of unread mails.
        case count(Int)
        /// A count on a red pill: something that waits for the person.
        case badge(Int)
    }

    // MARK: - Properties
    let id: String
    let symbol: String
    let tile: Color
    let title: Text
    var subtitle: Text?
    var trailing: Trailing = .none
    let target: OverviewTarget
    let identifier: String
}

/// A row of the overview list: a button that asks the shared ViewModel to open its target, with a native `Label` and
/// the value of `LabeledContent` on the trailing side.
struct OverviewRowButton: View {

    // MARK: - Dependencies
    let row: OverviewRow
    let open: (OverviewTarget) -> Void

    // MARK: - Body
    var body: some View {
        Button { open(row.target) } label: { OverviewRowLabel(row: row) }
            .listRowButton()
            .tint(.primary)
            .accessibilityIdentifier(row.identifier)
    }
}

// MARK: - Label
private struct OverviewRowLabel: View {

    // MARK: - Dependencies
    let row: OverviewRow

    // MARK: - Body
    var body: some View {
        LabeledContent {
            HStack(spacing: Theme.Spacing.small) {
                trailing
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
        } label: {
            Label {
                row.title
                if let subtitle = row.subtitle { subtitle }
            } icon: {
                Image(systemName: row.symbol)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 30, height: 30)
                    .background(row.tile, in: .rect(cornerRadius: 8))
            }
        }
        .contentShape(.rect)
    }

    @ViewBuilder private var trailing: some View {
        switch row.trailing {
        case .none:
            EmptyView()
        case .count(let count):
            Text(count, format: .number)
        case .badge(let count):
            Text(count, format: .number)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 7)
                .frame(minWidth: 22, minHeight: 22)
                .background(Theme.Colors.destructive, in: Capsule())
        }
    }
}
