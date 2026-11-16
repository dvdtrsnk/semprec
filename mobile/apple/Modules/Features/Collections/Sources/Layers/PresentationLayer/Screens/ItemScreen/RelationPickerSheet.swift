import CoreKit
import DesignSystem
import SwiftUI

/// Points a relation at another item: a search over the items of the database it targets, then a tap.
struct RelationPickerSheet: View {

    // MARK: - Dependencies
    let picker: PickerView
    let send: (ItemAction) -> Void

    // MARK: - State
    @State private var query = ""

    // MARK: - Body
    var body: some View {
        NavigationStack {
            content
                .navigationTitle(picker.name)
                .inlineNavigationTitle()
                .searchable(text: $query, prompt: Text("picker.search", bundle: .module))
                .onSubmit(of: .search) { send(.picker(.search(query))) }
                .onChange(of: query) { _, text in send(.picker(.search(text))) }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button { send(.picker(.close)) } label: { Text("picker.cancel", bundle: .module) }
                    }
                }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(CollectionsIdentifiers.pickerSheet)
    }
}

// MARK: - Subviews
private extension RelationPickerSheet {

    @ViewBuilder var content: some View {
        if picker.loading && picker.candidates.isEmpty {
            StatusView(.loading)
        } else if let failure = picker.failure {
            StatusView(.failure(message: Text(FailureKind.message(for: failure.kind)), retry: {
                send(.picker(.open(propertyKey: picker.propertyKey)))
            }))
        } else if picker.candidates.isEmpty {
            StatusView(.empty(message: Text("picker.empty", bundle: .module), systemImage: "magnifyingglass"))
        } else {
            List(picker.candidates, id: \.id) { target in
                Button { send(.picker(.choose(targetId: target.id))) } label: {
                    HStack {
                        CollectionBadge(
                            title: target.title,
                            tint: Color(hex: target.color) ?? Theme.Colors.accent,
                            isRound: true,
                            size: 30
                        )
                        Text(target.title)
                        Spacer()
                    }
                    .contentShape(Rectangle())
                }
                .listRowButton()
                .foregroundStyle(.primary)
            }
        }
    }
}
