import CoreKit
import DesignSystem
import SwiftUI

/// The strip above a collection: the filter button, then the quick filters the server declares for the database.
struct QuickFilterBar: View {

    // MARK: - Dependencies
    let chips: [QuickFilterChip]
    let selected: String?
    let activeFilterCount: Int
    let canFilter: Bool
    let tint: Color
    let send: (CollectionAction) -> Void

    // MARK: - Body
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.small) {
                if canFilter {
                    filterButton
                }
                ForEach(chips) { chip in
                    chipButton(chip)
                }
            }
            .padding(.horizontal, Theme.Spacing.medium)
            .padding(.vertical, 6)
        }
        // A horizontal scroll view takes all the height it is offered; in a safe area bar that is the whole screen,
        // which drew the bar's scroll edge effect over the collection.
        .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - Subviews
private extension QuickFilterBar {

    var filterButton: some View {
        Button { send(.filter(.open)) } label: {
            HStack(spacing: 6) {
                Image(systemName: "line.3.horizontal.decrease")
                Text("filter.button", bundle: .module)
                if activeFilterCount > 0 {
                    Text("\(activeFilterCount)")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .background(tint, in: Capsule())
                }
            }
            .font(.subheadline)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Theme.Colors.card, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(CollectionsIdentifiers.filterButton)
    }

    func chipButton(_ chip: QuickFilterChip) -> some View {
        let isSelected = chip.key == selected
        return Button { send(.selectQuickFilter(chip.key)) } label: {
            Text(chip.label)
                .font(.subheadline.weight(isSelected ? .semibold : .regular))
                .foregroundStyle(isSelected ? Color.white : Color.primary)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(isSelected ? tint : Theme.Colors.card, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier(CollectionsIdentifiers.quickFilterPrefix + chip.key)
    }
}
