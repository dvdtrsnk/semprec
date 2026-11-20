import CoreKit
import DesignSystem
import SwiftUI

/// The sleep sheet: the plan overview, one plan, one night and the pickers, switched by the shared state. The sheet
/// closes itself (the person's close and done buttons on its root view); going back inside it is a shared intent.
struct SleepScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: SleepViewModel
    @Environment(\.dismiss)
    private var dismiss

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> SleepViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        NavigationStack {
            content
                .navigationTitle(title)
                .inlineNavigationTitle()
                .toolbar { toolbar }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(SleepIdentifiers.screen)
        .alert(
            Text("sleep.save.failed", bundle: .module),
            isPresented: saveFailed,
            actions: {
                Button { viewModel.send(.dismissSaveFailure) } label: { Text("sleep.save.dismiss", bundle: .module) }
            },
            message: { Text(FailureKind.sleepMessage(for: viewModel.state.saveFailure)) }
        )
        .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension SleepScreen {

    var state: SleepState {
        viewModel.state
    }

    var send: (SleepAction) -> Void {
        { [viewModel] in viewModel.send($0) }
    }

    @ViewBuilder var content: some View {
        switch state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.sleepMessage(for: failure)), retry: viewModel.retry))
        case .ready:
            page.allowsHitTesting(!state.saving)
        }
    }

    @ViewBuilder var page: some View {
        switch state.page {
        case .main: SleepMainPage(state: state, send: send)
        case .plan: SleepPlanPage(state: state, send: send)
        case .night: SleepNightPage(state: state, send: send)
        case .remind, .sound, .goal: SleepPickerPage(state: state, send: send)
        }
    }

    var saveFailed: Binding<Bool> {
        Binding(
            get: { viewModel.state.saveFailed },
            set: { if !$0 { viewModel.send(.dismissSaveFailure) } }
        )
    }

    var title: Text {
        switch state.page {
        case .main: Text("sleep.title", bundle: .module)
        case .plan: Text(state.plans.first { $0.id == state.selectedPlanID }?.name ?? "")
        case .night: nightTitle
        case .remind: Text("sleep.remind.title", bundle: .module)
        case .sound: Text("sleep.sound.title", bundle: .module)
        case .goal: Text("sleep.goal.title", bundle: .module)
        }
    }

    /// Tonight, last night, or just a night, with the evening and the morning it spans.
    var nightTitle: Text {
        guard let night = state.night?.night, let date = SleepFormat.date(of: night) else {
            return Text("sleep.night.other", bundle: .module)
        }
        let calendar = Calendar.current
        let range = SleepFormat.range(of: night).map { " · " + $0 } ?? ""
        let name: Text
        if calendar.isDateInToday(date) {
            name = Text("sleep.night.today", bundle: .module)
        } else if calendar.isDateInYesterday(date) {
            name = Text("sleep.night.last", bundle: .module)
        } else {
            name = Text("sleep.night.other", bundle: .module)
        }
        return Text("\(name)\(Text(range))")
    }

    @ToolbarContentBuilder var toolbar: some ToolbarContent {
        PlainToolbarItem(placement: .cancellationAction) {
            if state.isRoot {
                Button { dismiss() } label: {
                    Label { Text("sleep.close", bundle: .module) } icon: { Image(systemName: "xmark") }
                }
                .accessibilityIdentifier(SleepIdentifiers.close)
            } else {
                Button { viewModel.send(.back) } label: {
                    Label { Text("sleep.back", bundle: .module) } icon: { Image(systemName: "chevron.backward") }
                }
                .accessibilityIdentifier(SleepIdentifiers.back)
            }
        }
        ToolbarItem(placement: .confirmationAction) {
            if state.isRoot {
                Button { dismiss() } label: { Text("sleep.done", bundle: .module) }
                    .accessibilityIdentifier(SleepIdentifiers.done)
            }
        }
    }
}

// MARK: - Preview
#Preview("Overview") {
    SleepScreen(viewModel: SleepViewModel(model: ScriptedSleepScreenModel(state: .previewReady)))
}

#Preview("Plan") {
    SleepScreen(viewModel: SleepViewModel(model: ScriptedSleepScreenModel(state: .previewReady.opening(.plan))))
}

#Preview("Night") {
    SleepScreen(viewModel: SleepViewModel(model: ScriptedSleepScreenModel(state: .previewReady.opening(.night))))
}

#Preview("Loading") {
    SleepScreen(viewModel: SleepViewModel(model: ScriptedSleepScreenModel(state: SleepState())))
}

#Preview("Unavailable") {
    SleepScreen(
        viewModel: SleepViewModel(model: ScriptedSleepScreenModel(state: SleepState(phase: .failure(.unavailable))))
    )
}
