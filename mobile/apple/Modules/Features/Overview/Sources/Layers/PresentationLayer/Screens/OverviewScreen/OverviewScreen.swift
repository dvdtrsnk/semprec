import CoreKit
import DesignSystem
import SwiftUI

/// The overview: what waits for the person, the areas, the pinned projects and the collections, with a search that
/// opens in place and a profile button. Rows ask the shared ViewModel to open their target; the app shows it.
///
/// The page is a native grouped list with a large navigation title. On iOS the search and profile buttons are toolbar
/// items; on macOS they stay in the page, because a macOS window that has toolbar items keeps the whole view graph of
/// the window, with the scene's composition in it, alive after the window closed (`SceneLifetimeTests`).
struct OverviewScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: OverviewViewModel
    private let makeSearch: @MainActor () -> any SearchScreenModel
    private let router: any OverviewRouting
    @Environment(\.scenePhase)
    private var scenePhase

    // MARK: - State
    @State private var isSearching = false
    @State private var hasAppeared = false
    /// How far the list is scrolled, for the paper behind it alone.
    @State private var paperScroll = PaperScroll()

    // MARK: - Init
    init(
        viewModel: @autoclosure @escaping () -> OverviewViewModel,
        makeSearch: @escaping @MainActor () -> any SearchScreenModel,
        router: any OverviewRouting
    ) {
        _viewModel = StateObject(wrappedValue: viewModel())
        self.makeSearch = makeSearch
        self.router = router
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text("overview.title", bundle: .module))
            .navigationSubtitle(Text(Date.now, format: .dateTime.weekday(.wide).day().month(.wide)))
            .toolbar {
                #if os(iOS)
                    if !isSearching {
                        PlainToolbarItemGroup(placement: .primaryAction) { searchButton; profileButton }
                    }
                #endif
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(OverviewIdentifiers.screen)
            .task { await viewModel.observe() }
            // The server changes problems and counts on its own; coming back to the screen reads them again.
            .onAppear {
                if hasAppeared { viewModel.reload() }
                hasAppeared = true
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { viewModel.reload() }
            }
    }
}

// MARK: - Subviews
private extension OverviewScreen {

    @ViewBuilder var content: some View {
        if isSearching {
            SearchScreen(viewModel: SearchViewModel(model: makeSearch(), router: router)) { isSearching = false }
        } else {
            VStack(spacing: 0) {
                #if os(macOS)
                    HStack(spacing: Theme.Spacing.small) { Spacer(); searchButton; profileButton }
                        .padding(.horizontal, Theme.Spacing.medium)
                        .padding(.top, Theme.Spacing.small)
                #endif
                switch viewModel.state {
                case .loading:
                    StatusView(.loading)
                case .failure(let failure):
                    StatusView(
                        .failure(message: Text(FailureKind.message(for: failure)), retry: { viewModel.retry() })
                    )
                case .content(let content):
                    overview(content)
                }
            }
            // The diary's paper, its haze scrolling away with the list.
            .background { PaperBackground(scroll: paperScroll) }
        }
    }

    var searchButton: some View {
        Button { isSearching = true } label: {
            Label { Text("overview.search", bundle: .module) } icon: { Image(systemName: "magnifyingglass") }
        }
        .accessibilityIdentifier(OverviewIdentifiers.search)
    }

    var profileButton: some View {
        Button { viewModel.open(.profile) } label: { ProfileBadge(state: viewModel.state) }
            .accessibilityLabel(profileLabel)
            .accessibilityIdentifier(OverviewIdentifiers.profile)
    }

    func overview(_ content: OverviewContent) -> some View {
        List {
            section("overview.section.main", rows: OverviewRows.main(content))
            section("overview.section.areas", rows: OverviewRows.areas(content))
            section("overview.section.projects", rows: OverviewRows.projects(content))
            section("overview.section.collections", rows: OverviewRows.collections(content))
        }
        .groupedListStyle()
        .scrollContentBackground(.hidden)
        .paperScroll(paperScroll)
        .refreshable { await viewModel.refresh() }
        .accessibilityIdentifier(OverviewIdentifiers.content)
    }

    @ViewBuilder
    func section(_ title: LocalizedStringKey, rows: [OverviewRow]) -> some View {
        if !rows.isEmpty {
            Section {
                ForEach(rows) { row in OverviewRowButton(row: row) { viewModel.open($0) } }
            } header: {
                Text(title, bundle: .module)
            }
            .headerProminence(.increased)
        }
    }

    var profileLabel: Text {
        guard case .content(let content) = viewModel.state, content.problemCount > 0 else {
            return Text("overview.profile", bundle: .module)
        }
        let format = String(localized: "overview.profile.problems", bundle: .module)
        return Text(verbatim: String(format: format, locale: .current, content.problemCount))
    }

}

/// The avatar of the profile button: the initials of the account, with a red dot while Semp has problems.
private struct ProfileBadge: View {

    // MARK: - Dependencies
    let state: OverviewState

    // MARK: - Body
    var body: some View {
        ZStack(alignment: .topTrailing) {
            Text(verbatim: initials)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(Color.indigo, in: Circle())
            if hasProblems {
                Circle()
                    .fill(Theme.Colors.destructive)
                    .frame(width: 12, height: 12)
                    .offset(x: 4, y: -4)
            }
        }
    }

    // MARK: - Content
    private var content: OverviewContent? {
        if case .content(let content) = state { content } else { nil }
    }

    private var initials: String {
        ProfileInitials.text(name: content?.accountName, email: content?.accountEmail) ?? "\u{2022}"
    }

    private var hasProblems: Bool {
        (content?.problemCount ?? 0) > 0
    }
}

// MARK: - Preview
#Preview("Content") {
    NavigationStack {
        OverviewScreen(
            viewModel: OverviewViewModel(
                model: ScriptedOverviewScreenModel(state: .content(PreviewOverview.content)),
                router: PreviewOverviewRouter()
            ),
            makeSearch: { ScriptedSearchScreenModel(state: SearchState()) },
            router: PreviewOverviewRouter()
        )
    }
}

#Preview("Loading") {
    NavigationStack {
        OverviewScreen(
            viewModel: OverviewViewModel(
                model: ScriptedOverviewScreenModel(state: .loading),
                router: PreviewOverviewRouter()
            ),
            makeSearch: { ScriptedSearchScreenModel(state: SearchState()) },
            router: PreviewOverviewRouter()
        )
    }
}
