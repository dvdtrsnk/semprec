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
    /// The schedule the editor sheet is open on. The sheet is presented from the screen, not from a row of its form:
    /// a sheet presented from a form row inside another sheet dismissed both.
    @State private var editing: ScheduleEditorTarget?
    /// The screen of how the alarms wake the person, which the app provides; presented from the screen like the
    /// editor.
    private let wakeSettings: (@MainActor () -> AnyView)?
    @State private var showsWakeSettings = false

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> SleepViewModel, wakeSettings: (@MainActor () -> AnyView)? = nil) {
        _viewModel = StateObject(wrappedValue: viewModel())
        self.wakeSettings = wakeSettings
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
        .sheet(item: $editing) { target in editor(target) }
        .sheet(isPresented: $showsWakeSettings) { wakeSettings?() }
        .task { await viewModel.observe() }
    }
}

/// Which schedule the editor sheet changes: an existing plan, or a new one.
private enum ScheduleEditorTarget: Identifiable, Hashable {

    case plan(String)
    case new

    var id: String {
        switch self {
        case .plan(let id): "plan." + id
        case .new: "new"
        }
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
        // The plan page of the shared model is the schedule editor's sheet here, so the overview stands in for it.
        case .main, .plan:
            SleepMainPage(
                state: state,
                send: send,
                edit: { plan in editing = plan.map { .plan($0.id) } ?? .new },
                openWakeSettings: wakeSettings == nil ? nil : { showsWakeSettings = true }
            )
        case .night: SleepNightPage(state: state, send: send)
        case .remind, .sound, .goal: SleepPickerPage(state: state, send: send)
        }
    }

    func editor(_ target: ScheduleEditorTarget) -> some View {
        // The editor writes to the plan it opened on, even when a later state no longer lists that plan.
        let planID: String? = switch target {
        case .plan(let id): id
        case .new: nil
        }
        let plan = state.plans.first { $0.id == planID }
        let otherDays = Set(state.plans.filter { $0.id != plan?.id }.flatMap(\.wakeDays))
        return SleepScheduleEditor(
            plan: plan,
            template: state.plans.first,
            otherDays: otherDays,
            goalMinutes: state.goalMinutes,
            lengths: state.shortestNightMinutes...state.longestNightMinutes,
            canDelete: state.canDeletePlan,
            save: { draft in
                let days = draft.days.sorted()
                send(.savePlan(
                    planID: planID,
                    name: plan?.name ?? SleepFormat.days(days),
                    wakeDays: days,
                    bedMinutes: draft.bedMinutes,
                    wakeMinutes: draft.wakeMinutes,
                    alarm: draft.alarm
                ))
            },
            delete: { if let planID { send(.removePlan(planID: planID)) } }
        )
    }

    var saveFailed: Binding<Bool> {
        Binding(
            get: { viewModel.state.saveFailed },
            set: { if !$0 { viewModel.send(.dismissSaveFailure) } }
        )
    }

    var title: Text {
        switch state.page {
        case .main, .plan: Text("sleep.title", bundle: .module)
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
