import CoreKit
import SwiftUI

/// The filter button of a collection's toolbar: a system menu with the quick filters the server declares for the
/// database as a picker, and the full filter sheet below them. The symbol is filled while any filter narrows the
/// collection beyond the quick filter.
struct CollectionFilterMenu: View {

    // MARK: - Dependencies
    let state: CollectionState
    let send: (CollectionAction) -> Void

    // MARK: - Body
    var body: some View {
        Menu {
            if !state.quickFilters.isEmpty {
                Picker(selection: quickFilterBinding) {
                    ForEach(state.quickFilters) { chip in
                        Text(chip.label).tag(String?.some(chip.key))
                    }
                } label: {
                    Text("collection.quickFilters", bundle: .module)
                }
                .pickerStyle(.inline)
            }
            if state.header != nil {
                Button { send(.filter(.open)) } label: {
                    Label { filtersTitle } icon: { Image(systemName: "slider.horizontal.3") }
                }
                .accessibilityIdentifier(CollectionsIdentifiers.filterButton)
            }
        } label: {
            Label {
                Text("filter.button", bundle: .module)
            } icon: {
                Image(systemName: state.activeFilterCount > 0
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease.circle")
            }
        }
        .accessibilityIdentifier(CollectionsIdentifiers.filterMenu)
    }
}

// MARK: - Private
private extension CollectionFilterMenu {

    var quickFilterBinding: Binding<String?> {
        Binding(
            get: { state.selectedQuickFilter },
            set: { key in if let key, key != state.selectedQuickFilter { send(.selectQuickFilter(key)) } }
        )
    }

    /// "Filters" with the number of filters set in the sheet, when there are any.
    var filtersTitle: Text {
        guard state.activeFilterCount > 0 else { return Text("collection.filters.more", bundle: .module) }
        return Text(String(
            format: String(localized: "collection.filters.moreCount", bundle: .module),
            state.activeFilterCount
        ))
    }
}
