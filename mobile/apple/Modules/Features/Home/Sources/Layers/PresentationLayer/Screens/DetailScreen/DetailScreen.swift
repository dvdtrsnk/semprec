import CoreKit
import DesignSystem
import SwiftUI

/// One placeholder item, or why it cannot be shown.
struct DetailScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: DetailViewModel

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> DetailViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(HomeIdentifiers.detailScreen)
            .navigationTitle(Text("detail.title", bundle: .module))
            .inlineNavigationTitle()
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension DetailScreen {

    @ViewBuilder var content: some View {
        switch viewModel.state {
        case .loading:
            StatusView(.loading)
        case .content(let item):
            itemView(item)
        case .notFound:
            StatusView(.empty(message: Text("detail.notFound", bundle: .module), systemImage: "questionmark.folder"))
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.message(for: failure)), retry: viewModel.retry))
        }
    }

    func itemView(_ item: PlaceholderItem) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            Text(item.title)
                .font(Theme.Typography.title)
                .accessibilityIdentifier(HomeIdentifiers.detailTitle)
            Text("detail.description", bundle: .module)
                .font(Theme.Typography.body)
                .foregroundStyle(Theme.Colors.secondaryText)
        }
        .padding(Theme.Spacing.medium)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Preview
#Preview("Content") {
    NavigationStack {
        DetailScreen(viewModel: DetailViewModel(
            model: ScriptedDetailScreenModel(state: .content(PlaceholderItem(id: "item-1", ordinal: 1)))
        ))
    }
}

#Preview("Not found") {
    NavigationStack {
        DetailScreen(viewModel: DetailViewModel(model: ScriptedDetailScreenModel(state: .notFound)))
    }
}

#Preview("Invalid data") {
    NavigationStack {
        DetailScreen(viewModel: DetailViewModel(model: ScriptedDetailScreenModel(state: .failure(.invalidData))))
    }
}
