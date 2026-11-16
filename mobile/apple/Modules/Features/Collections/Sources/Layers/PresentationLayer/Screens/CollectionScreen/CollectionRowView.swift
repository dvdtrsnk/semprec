import CoreKit
import DesignSystem
import SwiftUI

/// One item of a list: a badge, the title with a subtitle that says what it is, and its status as a pill.
struct CollectionRowView: View {

    // MARK: - Dependencies
    let row: CollectionRow
    let appearance: CollectionAppearance
    let showsStatus: Bool
    let action: () -> Void

    // MARK: - Body
    var body: some View {
        Button(action: action) {
            HStack(spacing: Theme.Spacing.medium) {
                CollectionBadge(
                    title: row.title,
                    tint: appearance.tint(of: row),
                    isRound: appearance.isRound,
                    label: appearance.badgeLabel(of: row)
                )
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title).font(.body).lineLimit(1)
                    if !subtitle.isEmpty {
                        Text(subtitle).font(.footnote).foregroundStyle(Theme.Colors.secondaryText).lineLimit(1)
                    }
                    if let rating = row.rating {
                        RatingStars(rating: rating)
                    }
                }
                Spacer(minLength: Theme.Spacing.small)
                if showsStatus, let group = row.group {
                    StatusPill(option: group)
                }
            }
            .contentShape(Rectangle())
        }
        .listRowButton()
        .foregroundStyle(.primary)
        .accessibilityIdentifier(CollectionsIdentifiers.rowPrefix + row.id)
    }
}

// MARK: - Subviews
private extension CollectionRowView {

    var subtitle: String {
        appearance.format.subtitle(row.subtitle)
    }
}

/// The status of an item as a small tinted capsule.
struct StatusPill: View {

    // MARK: - Dependencies
    let option: FieldOption

    // MARK: - Body
    var body: some View {
        let tint = Color(hex: option.color) ?? Theme.Colors.secondaryText
        Text(option.label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tint.opacity(0.14), in: Capsule())
            .lineLimit(1)
    }
}

// MARK: - Preview
#Preview {
    List {
        CollectionRowView(
            row: CollectionRow(
                id: "p1",
                title: "Semprec iOS",
                group: FieldOption(key: "inProgress", label: "In progress", color: "#007AFF"),
                date: "2027-01-31",
                subtitle: [.targets([FieldTarget(id: "a", databaseKey: "areas", title: "Work", color: nil)])],
                fileType: nil
            ),
            appearance: CollectionAppearance(databaseKey: "projects", color: "#AF52DE"),
            showsStatus: true,
            action: {}
        )
    }
}
