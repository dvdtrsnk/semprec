import CoreKit
import DesignSystem
import SwiftUI

/// The overview: what waits for the person, the areas, the pinned projects and the collections, with a search that
/// opens in place and a profile button. Rows ask the shared ViewModel to open their target; the app shows it.
///
/// The two glass buttons sit in the page, as in the design, and not in a toolbar: a macOS window that has toolbar items
/// keeps the whole view graph of the window, with the scene's composition in it, alive after the window closed
/// (`SceneLifetimeTests`).
struct OverviewScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: OverviewViewModel
    private let makeSearch: @MainActor () -> any SearchScreenModel
    private let router: any OverviewRouting

    // MARK: - State
    @State private var isSearching = false

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
            .background(Theme.Colors.groupedBackground)
            .navigationTitle(Text("overview.title", bundle: .module))
            .hiddenNavigationBar()
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(OverviewIdentifiers.screen)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension OverviewScreen {

    @ViewBuilder var content: some View {
        if isSearching {
            SearchScreen(viewModel: SearchViewModel(model: makeSearch(), router: router)) { isSearching = false }
        } else {
            VStack(spacing: 0) {
                buttons
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
        }
    }

    /// The search and profile buttons, glass circles at the top right of the page.
    var buttons: some View {
        HStack(spacing: Theme.Spacing.small + 2) {
            Spacer()
            Button { isSearching = true } label: {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: Self.buttonSize, height: Self.buttonSize)
                    .glassEffect(.regular.interactive(), in: .circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("overview.search", bundle: .module))
            .accessibilityIdentifier(OverviewIdentifiers.search)
            Button { viewModel.open(.profile) } label: {
                ProfileBadge(state: viewModel.state)
                    .frame(width: Self.buttonSize, height: Self.buttonSize)
                    .glassEffect(.regular.interactive(), in: .circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(profileLabel)
            .accessibilityIdentifier(OverviewIdentifiers.profile)
        }
        .padding(.horizontal, Theme.Spacing.medium)
        .padding(.top, Theme.Spacing.small)
    }

    func overview(_ content: OverviewContent) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("overview.title", bundle: .module)
                        .font(.largeTitle.weight(.bold))
                        .accessibilityAddTraits(.isHeader)
                    Text(Date.now, format: .dateTime.weekday(.wide).day().month(.wide))
                        .font(.subheadline)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                .padding(.horizontal, Theme.Spacing.small)
                section("overview.section.main", rows: OverviewRows.main(content))
                section("overview.section.areas", rows: OverviewRows.areas(content))
                section("overview.section.projects", rows: OverviewRows.projects(content))
                section("overview.section.collections", rows: OverviewRows.collections(content))
            }
            .padding(.horizontal, Theme.Spacing.medium)
            .padding(.bottom, Theme.Spacing.large)
        }
        .refreshable { await viewModel.refresh() }
        .accessibilityIdentifier(OverviewIdentifiers.content)
    }

    @ViewBuilder
    func section(_ title: LocalizedStringKey, rows: [OverviewRow]) -> some View {
        if !rows.isEmpty {
            Text(title, bundle: .module)
                .font(.title3.weight(.bold))
                .padding(.top, Theme.Spacing.large)
                .padding(.bottom, Theme.Spacing.small)
                .padding(.horizontal, Theme.Spacing.small)
                .accessibilityAddTraits(.isHeader)
            OverviewCard(rows: rows) { viewModel.open($0) }
        }
    }

    var profileLabel: Text {
        guard case .content(let content) = viewModel.state, content.problemCount > 0 else {
            return Text("overview.profile", bundle: .module)
        }
        let format = String(localized: "overview.profile.problems", bundle: .module)
        return Text(verbatim: String(format: format, locale: .current, content.problemCount))
    }

    static var buttonSize: CGFloat { 44 }
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
        ProfileInitials.text(email: content?.accountEmail) ?? "\u{2022}"
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
