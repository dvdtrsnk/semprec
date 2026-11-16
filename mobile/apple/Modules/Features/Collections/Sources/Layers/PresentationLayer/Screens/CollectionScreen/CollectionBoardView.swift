import CoreKit
import DesignSystem
import SwiftUI

/// The items as a board: one column per status, each with its cards.
struct CollectionBoardView: View {

    // MARK: - Dependencies
    let sections: [CollectionSection]
    let appearance: CollectionAppearance
    let open: (CollectionRow) -> Void

    // MARK: - Body
    var body: some View {
        ScrollView(.horizontal) {
            LazyHStack(alignment: .top, spacing: Theme.Spacing.medium) {
                ForEach(sections) { section in
                    column(section)
                }
            }
            .padding(Theme.Spacing.medium)
        }
    }
}

// MARK: - Subviews
private extension CollectionBoardView {

    func column(_ section: CollectionSection) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            HStack {
                CollectionSectionHeader(section: section, format: appearance.format)
                Spacer()
                Text("\(section.rows.count)").font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
            }
            ScrollView {
                LazyVStack(spacing: Theme.Spacing.small) {
                    ForEach(section.rows) { row in
                        card(row)
                    }
                }
            }
        }
        .padding(Theme.Spacing.small)
        .frame(width: 270, alignment: .top)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.Colors.groupedBackground, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    func card(_ row: CollectionRow) -> some View {
        Button { open(row) } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(row.title).font(.subheadline.weight(.semibold)).multilineTextAlignment(.leading)
                let subtitle = appearance.format.subtitle(row.subtitle)
                if !subtitle.isEmpty {
                    Text(subtitle).font(.footnote).foregroundStyle(Theme.Colors.secondaryText).lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.Spacing.small + 4)
            .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(CollectionsIdentifiers.rowPrefix + row.id)
        .dropTarget(appearance.sempTarget(of: row))
    }
}
