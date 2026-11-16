import CoreKit
import DesignSystem
import SwiftUI

/// The items as tiles, grouped under the same headings as the list.
struct CollectionGalleryView: View {

    // MARK: - Dependencies
    let sections: [CollectionSection]
    let appearance: CollectionAppearance
    let open: (CollectionRow) -> Void

    // MARK: - Body
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Theme.Spacing.medium, pinnedViews: []) {
                ForEach(sections) { section in
                    if section.kind != .none {
                        CollectionSectionHeader(section: section, format: appearance.format)
                            .padding(.horizontal, Theme.Spacing.medium)
                    }
                    LazyVGrid(columns: columns, spacing: Theme.Spacing.medium) {
                        ForEach(section.rows) { row in
                            tile(row)
                        }
                    }
                    .padding(.horizontal, Theme.Spacing.medium)
                }
            }
            .padding(.vertical, Theme.Spacing.medium)
        }
    }
}

// MARK: - Subviews
private extension CollectionGalleryView {

    var columns: [GridItem] {
        [GridItem(.adaptive(minimum: 104), spacing: Theme.Spacing.medium)]
    }

    func tile(_ row: CollectionRow) -> some View {
        Button { open(row) } label: {
            VStack(spacing: Theme.Spacing.small) {
                CollectionBadge(
                    title: row.title,
                    tint: appearance.tint(of: row),
                    isRound: appearance.isRound,
                    label: appearance.badgeLabel(of: row),
                    size: 72
                )
                Text(row.title).font(.footnote.weight(.medium)).lineLimit(2).multilineTextAlignment(.center)
                if let subtitle = subtitle(row) {
                    Text(subtitle).font(.caption2).foregroundStyle(Theme.Colors.secondaryText).lineLimit(1)
                }
                if let rating = row.rating {
                    RatingStars(rating: rating)
                }
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(CollectionsIdentifiers.rowPrefix + row.id)
        .dropTarget(appearance.sempTarget(of: row))
    }

    func subtitle(_ row: CollectionRow) -> String? {
        let text = appearance.format.subtitle(row.subtitle)
        return text.isEmpty ? nil : text
    }
}
