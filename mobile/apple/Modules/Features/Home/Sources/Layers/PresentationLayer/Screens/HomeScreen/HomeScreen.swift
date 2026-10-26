import CoreKit
import DesignSystem
import SwiftUI

/// The placeholder list. Selecting an item asks the shared ViewModel, which decides to open its detail.
struct HomeScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: HomeViewModel

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> HomeViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(HomeIdentifiers.screen)
            .navigationTitle(Text("home.title", bundle: .module))
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension HomeScreen {

    @ViewBuilder var content: some View {
        switch viewModel.state {
        case .loading:
            StatusView(.loading)
        case .content(let items):
            list(items)
        case .empty:
            StatusView(.empty(message: Text("home.empty", bundle: .module), systemImage: "tray"))
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.message(for: failure)), retry: viewModel.retry))
        }
    }

    func list(_ items: [PlaceholderItem]) -> some View {
        List(items) { item in
            Button(item.title) { viewModel.select(item) }
                .listRowButton()
                .accessibilityIdentifier(HomeIdentifiers.itemPrefix + item.id)
        }
    }
}

// MARK: - Preview
#Preview("Content") {
    NavigationStack {
        HomeScreen(viewModel: HomeViewModel(
            model: ScriptedHomeScreenModel(state: .content([
                PlaceholderItem(id: "item-1", ordinal: 1), PlaceholderItem(id: "item-2", ordinal: 2)
            ])),
            router: PreviewHomeRouter()
        ))
    }
}

#Preview("Empty") {
    NavigationStack {
        HomeScreen(viewModel: HomeViewModel(
            model: ScriptedHomeScreenModel(state: .empty),
            router: PreviewHomeRouter()
        ))
    }
}

#Preview("Unavailable") {
    NavigationStack {
        HomeScreen(viewModel: HomeViewModel(
            model: ScriptedHomeScreenModel(state: .failure(.unavailable)),
            router: PreviewHomeRouter()
        ))
    }
}

#Preview("Unexpected failure") {
    NavigationStack {
        HomeScreen(viewModel: HomeViewModel(
            model: ScriptedHomeScreenModel(state: .failure(nil)),
            router: PreviewHomeRouter()
        ))
    }
}
