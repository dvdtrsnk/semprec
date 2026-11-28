import CoreKit
import DesignSystem
import SwiftUI

/// Every tag of the projects, read through the project the settings were opened on; a tag opens its own screen
/// through the router. The list is read again when the screen appears again, so a tag renamed, recolored or deleted
/// on its screen shows as it is now.
struct ProjectTagsScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: ItemViewModel

    // MARK: - State
    @State private var hasAppeared = false

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> ItemViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text(verbatim: tags?.name ?? ""))
            .inlineNavigationTitle()
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(CollectionsIdentifiers.projectTagsPage)
            .task { await viewModel.observe() }
            .onAppear { Self.appeared(&hasAppeared, send: viewModel.send) }
    }

    // MARK: - Methods
    /// One appearance of the screen: the first only records that it appeared, each later one, a return from a tag's
    /// screen, reads the tags again.
    static func appeared(_ hasAppeared: inout Bool, send: (ItemAction) -> Void) {
        if hasAppeared { send(.refresh) } else { hasAppeared = true }
    }
}

// MARK: - Subviews
private extension ProjectTagsScreen {

    var tags: FieldView? {
        viewModel.state.fields.first { $0.propertyKey == "tags" }
    }

    @ViewBuilder var content: some View {
        let state = viewModel.state
        switch state.phase {
        case .loading:
            StatusView(.loading)
        case .error:
            StatusView(.failure(
                message: Text(FailureKind.message(for: state.failure)),
                retry: { viewModel.send(.retry) }
            ))
        case .content:
            if let tags {
                ProjectTagsPage(tags: tags) { viewModel.showProject(.tag(key: $0)) }
            }
        }
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        ProjectTagsScreen(
            viewModel: ItemViewModel(
                itemId: "p1",
                model: ScriptedItemScreenModel(state: ItemState(phase: .content, fields: [ProjectTagPage.previewTags])),
                router: PreviewCollectionsRouter()
            )
        )
    }
}
