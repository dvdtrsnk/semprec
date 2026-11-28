import CoreKit
import DesignSystem
import SwiftUI

/// One tag of the projects, read through the project the settings were opened on: its name, its colour and its
/// deletion. The screen closes once the tag it shows is gone, while a refused change keeps it open with the failure.
struct ProjectTagScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: ItemViewModel
    private let tagKey: String
    @Environment(\.dismiss)
    private var dismiss

    // MARK: - Init
    init(tagKey: String, viewModel: @autoclosure @escaping () -> ItemViewModel) {
        self.tagKey = tagKey
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text(verbatim: tags?.options.first { $0.key == tagKey }?.label ?? ""))
            .inlineNavigationTitle()
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(CollectionsIdentifiers.projectTagPage)
            .task { await viewModel.observe() }
            .onChange(of: tags?.options ?? []) { before, now in
                if ProjectTagPage.wasRemoved(tagKey, before: before, now: now) { dismiss() }
            }
    }
}

// MARK: - Subviews
private extension ProjectTagScreen {

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
                ProjectTagPage(
                    tags: tags,
                    tagKey: tagKey,
                    swatches: state.swatches,
                    saving: state.saving,
                    failure: state.choiceFailure,
                    send: viewModel.send
                )
            }
        }
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        ProjectTagScreen(
            tagKey: "client",
            viewModel: ItemViewModel(
                itemId: "p1",
                model: ScriptedItemScreenModel(
                    state: ItemState(
                        phase: .content,
                        fields: [ProjectTagPage.previewTags],
                        swatches: [CalendarSwatch(key: "orange", hex: "#FF9500")]
                    )
                ),
                router: PreviewCollectionsRouter()
            )
        )
    }
}
