import CoreKit
import DesignSystem
import SwiftUI

/// The chips above a collection, one per value of the property its database declares for the bar (a project's tags),
/// each with how many items hold it. A chip toggles its value in the selection the filter sheet edits.
struct CollectionFacetBarView: View {

    // MARK: - Dependencies
    let bar: FacetBar
    let send: (CollectionAction) -> Void

    // MARK: - Body
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.small) {
                ForEach(bar.chips) { chip in
                    Button { send(Self.toggle(chip, of: bar)) } label: { label(chip) }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier(CollectionsIdentifiers.facetBarChipPrefix + chip.value)
                }
            }
            .padding(.horizontal, Theme.Spacing.medium)
            .padding(.vertical, Theme.Spacing.small)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(CollectionsIdentifiers.facetBar)
    }

    // MARK: - Methods
    /// What a tap on `chip` sends: the filter sheet's own toggle of that value.
    static func toggle(_ chip: FilterOption, of bar: FacetBar) -> CollectionAction {
        .filter(.toggle(propertyKey: bar.propertyKey, value: chip.value))
    }
}

// MARK: - Subviews
private extension CollectionFacetBarView {

    func label(_ chip: FilterOption) -> some View {
        FilterChip(
            title: chip.label,
            color: Color(hex: chip.color) ?? Theme.Colors.accent,
            isSelected: chip.selected
        ) {
            if let count = chip.count {
                Text(count, format: .number).font(.caption).foregroundStyle(Theme.Colors.secondaryText)
            }
        }
    }
}

// MARK: - Preview
#Preview {
    CollectionFacetBarView(
        bar: FacetBar(
            propertyKey: "tags",
            chips: [
                FilterOption(value: "client", label: "Client", color: "#FF9500", count: 3, selected: true),
                FilterOption(value: "home", label: "Home", color: nil, count: 1, selected: false)
            ]
        ),
        send: { _ in }
    )
}
