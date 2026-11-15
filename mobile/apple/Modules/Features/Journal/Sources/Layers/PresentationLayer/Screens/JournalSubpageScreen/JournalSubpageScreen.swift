import CoreKit
import DesignSystem
import SwiftUI

/// A subpage of the diary on its own screen: its blocks, edited the way the diary's notes are.
struct JournalSubpageScreen: View {

    // MARK: - Dependencies
    let title: String
    @StateObject private var viewModel: JournalSubpageViewModel

    // MARK: - Init
    init(title: String, viewModel: @autoclosure @escaping () -> JournalSubpageViewModel) {
        self.title = title
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(JournalIdentifiers.subpageScreen)
            .navigationTitle(title.isEmpty ? String(localized: "journal.subpage.untitled", bundle: .module) : title)
            .inlineNavigationTitle()
            .safeAreaInset(edge: .bottom) {
                if let problem = viewModel.state.editProblem {
                    JournalProblemBanner(
                        problem: problem,
                        onReload: viewModel.retry,
                        onDismiss: viewModel.dismissProblem
                    )
                }
            }
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension JournalSubpageScreen {

    @ViewBuilder var content: some View {
        switch viewModel.state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.message(for: failure)), retry: viewModel.retry))
        case .content:
            ScrollView {
                JournalPageEditor(
                    identifierPrefix: "subpage",
                    blocks: viewModel.state.blocks,
                    placeholder: String(localized: "journal.placeholder.subpage", bundle: .module),
                    saving: viewModel.state.saving,
                    hasProblem: viewModel.state.editProblem != nil,
                    onSetText: { viewModel.setText(index: $0, text: $1) },
                    onToggle: { viewModel.toggleDone(index: $0) },
                    onAdd: { viewModel.addBlock(kind: $0, text: $1) },
                    onOpenPage: { viewModel.openPage(pageId: $0, title: $1) }
                )
                .padding(Theme.Spacing.medium)
            }
        }
    }
}

// MARK: - Preview
#Preview("Content") {
    NavigationStack {
        JournalSubpageScreen(
            title: "Krkonoše – co sbalit",
            viewModel: JournalSubpageViewModel(
                model: ScriptedJournalSubpageScreenModel(state: JournalSubpageState(
                    phase: .content,
                    blocks: [
                        JournalBlock(index: 0, kind: .heading2, runs: [JournalRun(text: "Oblečení")]),
                        JournalBlock(index: 1, kind: .todo, done: true, runs: [JournalRun(text: "Nepromokavá bunda")]),
                        JournalBlock(index: 2, kind: .todo, runs: [JournalRun(text: "Pohorky")])
                    ]
                )),
                router: PreviewJournalRouter()
            )
        )
    }
}

#Preview("Unavailable") {
    NavigationStack {
        JournalSubpageScreen(
            title: "Stránka",
            viewModel: JournalSubpageViewModel(
                model: ScriptedJournalSubpageScreenModel(state: JournalSubpageState(phase: .failure(.unavailable))),
                router: PreviewJournalRouter()
            )
        )
    }
}
