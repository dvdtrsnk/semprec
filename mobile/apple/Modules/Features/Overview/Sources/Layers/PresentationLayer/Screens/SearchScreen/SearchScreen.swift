import CoreKit
import DesignSystem
import SwiftUI

/// The search overlay: a field to type into, the recent searches while nothing is typed, then the matches grouped by
/// kind, with the kinds as chips to narrow the search. The typed text stays in this view and goes to the shared
/// ViewModel as it changes; the return key remembers it. `onClose` leaves the search.
struct SearchScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: SearchViewModel
    private let onClose: () -> Void

    // MARK: - State
    @State private var query = ""
    @FocusState private var focused: Bool

    // MARK: - Init
    /// `viewModel` runs once per overlay, when SwiftUI creates the state object.
    init(viewModel: @autoclosure @escaping () -> SearchViewModel, onClose: @escaping () -> Void) {
        _viewModel = StateObject(wrappedValue: viewModel())
        self.onClose = onClose
    }

    // MARK: - Body
    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    chips
                    results
                }
                .padding(.horizontal, Theme.Spacing.medium)
                .padding(.bottom, Theme.Spacing.large)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(OverviewIdentifiers.searchScreen)
        .onChange(of: query) { _, text in viewModel.queryChanged(text) }
        .onAppear { focused = true }
        .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension SearchScreen {

    /// The field and the button that closes the search, as glass.
    var header: some View {
        HStack(spacing: Theme.Spacing.small + 2) {
            HStack(spacing: Theme.Spacing.small) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .accessibilityHidden(true)
                TextField(text: $query) { Text("search.prompt", bundle: .module) }
                    .textInput(.plain)
                    .focused($focused)
                    .submitLabel(.search)
                    .onSubmit { viewModel.submit(query) }
                    .accessibilityIdentifier(OverviewIdentifiers.searchField)
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain)
                        .foregroundStyle(Theme.Colors.secondaryText)
                        .accessibilityLabel(Text("search.clear", bundle: .module))
                        .accessibilityIdentifier(OverviewIdentifiers.searchClear)
                }
            }
            .padding(.horizontal, Theme.Spacing.medium)
            .frame(height: 44)
            .glassEffect(.regular, in: .capsule)
            Button { onClose() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 44, height: 44)
                    .glassEffect(.regular.interactive(), in: .circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("search.close", bundle: .module))
            .accessibilityIdentifier(OverviewIdentifiers.searchClose)
        }
        .padding(.horizontal, Theme.Spacing.medium)
        .padding(.top, Theme.Spacing.small)
        .padding(.bottom, Theme.Spacing.small)
    }

    var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.small) {
                ForEach(SearchScope.all) { scope in
                    chip(scope)
                }
            }
            .padding(.vertical, Theme.Spacing.small)
        }
    }

    func chip(_ scope: SearchScope) -> some View {
        let selected = viewModel.state.scope == scope.type
        return Button { viewModel.selectScope(scope.type) } label: {
            Text(scope.title, bundle: .module)
                .font(.subheadline.weight(selected ? .semibold : .regular))
                .foregroundStyle(selected ? AnyShapeStyle(.background) : AnyShapeStyle(.primary))
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(selected ? Theme.Colors.brand : Theme.Colors.card, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(OverviewIdentifiers.scopePrefix + scope.identifier)
    }

    @ViewBuilder var results: some View {
        let state = viewModel.state
        switch state.phase {
        case .recents:
            recents(state.recents)
        case .searching where state.groups.isEmpty:
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.top, Theme.Spacing.large)
        case .searching, .results:
            groups(state.groups)
        case .empty:
            StatusView(.empty(message: Text("search.empty", bundle: .module), systemImage: "magnifyingglass"))
                .frame(minHeight: 280)
                .accessibilityIdentifier(OverviewIdentifiers.noResults)
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.message(for: failure)), retry: { viewModel.retry() }))
                .frame(minHeight: 280)
        }
    }

    @ViewBuilder
    func recents(_ recents: [String]) -> some View {
        if !recents.isEmpty {
            Text("search.recent", bundle: .module)
                .font(.title3.weight(.bold))
                .padding(.top, Theme.Spacing.small)
                .padding(.bottom, Theme.Spacing.small)
                .accessibilityAddTraits(.isHeader)
            VStack(spacing: 0) {
                ForEach(Array(recents.enumerated()), id: \.offset) { index, recent in
                    if index > 0 {
                        Divider().padding(.leading, Theme.Spacing.large + Theme.Spacing.medium)
                    }
                    Button { query = recent } label: {
                        Label(recent, systemImage: "clock.arrow.circlepath")
                            .foregroundStyle(.primary)
                            .frame(maxWidth: .infinity, minHeight: Theme.Layout.rowHeight, alignment: .leading)
                            .padding(.horizontal, Theme.Spacing.medium)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(OverviewIdentifiers.recentPrefix + String(index))
                }
            }
            .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
        }
        Text("search.hint.title", bundle: .module)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Theme.Colors.secondaryText)
            .padding(.top, Theme.Spacing.large)
        Text("search.hint.body", bundle: .module)
            .font(.footnote)
            .foregroundStyle(Theme.Colors.secondaryText)
    }

    func groups(_ groups: [SearchGroup]) -> some View {
        ForEach(groups) { group in
            HStack(alignment: .firstTextBaseline) {
                Text(SearchScope(type: group.type).title, bundle: .module)
                    .font(.title3.weight(.bold))
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                count(of: group).foregroundStyle(Theme.Colors.secondaryText)
            }
            .padding(.top, Theme.Spacing.medium)
            .padding(.bottom, Theme.Spacing.small)
            VStack(spacing: 0) {
                ForEach(Array(group.results.enumerated()), id: \.element.id) { index, result in
                    if index > 0 {
                        Divider().padding(.leading, 60)
                    }
                    Button { viewModel.open(result, in: group.type) } label: {
                        SearchResultRow(result: result, type: group.type)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(OverviewIdentifiers.resultPrefix + result.key)
                }
            }
            .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
        }
    }

    func count(of group: SearchGroup) -> Text {
        guard group.total > group.results.count else { return Text(group.total, format: .number) }
        let format = String(localized: "search.group.partial", bundle: .module)
        return Text(verbatim: String(format: format, locale: .current, group.results.count, group.total))
    }
}

// MARK: - Preview
#Preview("Results") {
    SearchScreen(
        viewModel: SearchViewModel(
            model: ScriptedSearchScreenModel(state: PreviewOverview.searchResults),
            router: PreviewOverviewRouter()
        ),
        onClose: {}
    )
}

#Preview("Recent") {
    SearchScreen(
        viewModel: SearchViewModel(
            model: ScriptedSearchScreenModel(state: SearchState(recents: ["faktura", "koupelna"])),
            router: PreviewOverviewRouter()
        ),
        onClose: {}
    )
}
