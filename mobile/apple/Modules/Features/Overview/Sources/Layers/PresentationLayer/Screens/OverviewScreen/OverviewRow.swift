import CoreKit
import DesignSystem
import SwiftUI

/// One row of a card of the overview: a colored tile with a symbol, a title with an optional second line, what the row
/// counts, and the target it opens.
struct OverviewRow: Identifiable {

    // MARK: - Trailing
    enum Trailing: Equatable {

        case none
        /// A plain count, as the number of mails or collection items.
        case count(Int)
        /// A count on a red pill: something that waits for the person.
        case badge(Int)
        /// The word "Today": the journal row opens today's entry.
        case today
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

/// A card of rows, as the design groups them: rounded, with a hairline between rows that starts at the title.
struct OverviewCard: View {

    // MARK: - Dependencies
    let rows: [OverviewRow]
    let open: (OverviewTarget) -> Void

    // MARK: - Body
    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                if index > 0 {
                    Divider().padding(.leading, Self.dividerInset)
                }
                Button { open(row.target) } label: { OverviewRowLabel(row: row) }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(row.identifier)
            }
        }
        .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
    }

    // MARK: - Layout
    /// The tile, its padding and the gap before the title.
    private static let dividerInset: CGFloat = 60
}

// MARK: - Label
private struct OverviewRowLabel: View {

    // MARK: - Dependencies
    let row: OverviewRow

    // MARK: - Body
    var body: some View {
        HStack(spacing: Theme.Spacing.medium - 2) {
            Image(systemName: row.symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 30, height: 30)
                .background(row.tile, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                row.title.font(.body).foregroundStyle(.primary)
                if let subtitle = row.subtitle {
                    subtitle.font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            Spacer(minLength: Theme.Spacing.small)
            trailing
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, Theme.Spacing.medium)
        .frame(minHeight: Theme.Layout.rowHeight + 2)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var trailing: some View {
        switch row.trailing {
        case .none:
            EmptyView()
        case .count(let count):
            Text(count, format: .number).foregroundStyle(Theme.Colors.secondaryText)
        case .badge(let count):
            Text(count, format: .number)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 7)
                .frame(minWidth: 22, minHeight: 22)
                .background(Theme.Colors.destructive, in: Capsule())
        case .today:
            Text("overview.row.journal.today", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
        }
    }
}
