import DesignSystem
import SwiftUI

/// The pieces the new item form is built of, as the system Calendar draws them: rounded cards on the grouped
/// background, a grey heading above a card, a row with a symbol and a label, and a thin line between rows.
enum NewItemCard {

    // MARK: - Constants
    static let rowPadding: CGFloat = 16
    static let iconWidth: CGFloat = 28
    /// The calendar's own red, which marks the chosen day and the open pill as in the system Calendar.
    static let pickerTint = Color.red
}

// MARK: - Card
extension View {

    /// Draws the view as a card of the form.
    func newItemCard() -> some View {
        frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
    }
}

/// A grey heading above a card.
struct NewItemHeading: View {

    let key: LocalizedStringKey

    var body: some View {
        Text(key, tableName: "Sheets", bundle: .module)
            .font(.headline)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, NewItemCard.rowPadding + 4)
            .padding(.top, Theme.Spacing.small)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A row of a card: a symbol, a label and whatever the row holds at its trailing edge.
struct NewItemRow<Trailing: View>: View {

    let systemImage: String?
    let key: LocalizedStringKey
    /// The symbol's colour; grey unless the row stands for a colour of its own, as a flag does.
    var tint: Color?
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 12) {
            if let systemImage {
                Image(systemName: systemImage)
                    .foregroundStyle(tint.map(AnyShapeStyle.init) ?? AnyShapeStyle(.secondary))
                    .frame(width: NewItemCard.iconWidth)
            }
            Text(key, tableName: "Sheets", bundle: .module)
            Spacer(minLength: Theme.Spacing.small)
            trailing()
        }
        .padding(.horizontal, NewItemCard.rowPadding)
        .frame(minHeight: Theme.Layout.rowHeight)
    }
}

/// The line between the rows of a card, from where the row's text starts.
struct NewItemDivider: View {

    var inset: CGFloat = NewItemCard.rowPadding

    var body: some View {
        Divider().padding(.leading, inset)
    }
}
