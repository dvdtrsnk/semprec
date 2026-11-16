@preconcurrency internal import SharedSDK

/// The Kotlin `CalendarListViewModel` as a `CalendarListScreenModel`. Releasing the bridge closes the ViewModel.
@MainActor
final class SharedCalendarListScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.CalendarListViewModel
    private let effectQueue: EffectQueue<CalendarListEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.CalendarListViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedCalendarListScreenModel: ScreenModel {

    var state: CalendarListState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<CalendarListState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<CalendarListEffect> {
        effectQueue.stream()
    }

    func send(_ action: CalendarListAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedCalendarListScreenModel {

    static func state(_ state: SharedSDK.CalendarListState) -> CalendarListState {
        CalendarListState(
            phase: CalendarListPhase(state.phase, failure: state.failure),
            calendars: state.calendars.map(CalendarRow.init),
            swatches: state.swatches.map(CalendarSwatch.init),
            detailId: state.detailId,
            impact: state.impact.map(CalendarImpact.init),
            busy: state.busy,
            problem: state.problem,
            problemFailure: state.problemFailure.map(FailureKind.init)
        )
    }

    static func action(_ action: CalendarListAction) -> any SharedSDK.CalendarListAction {
        switch action {
        case .retry: SharedSDK.CalendarListActionRetry.shared
        case .toggleHidden(let id): SharedSDK.CalendarListActionChangeToggleHidden(calendarId: id)
        case .setAllHidden(let hidden): SharedSDK.CalendarListActionSetAllHidden(hidden: hidden)
        case .openDetail(let id): SharedSDK.CalendarListActionOpenDetail(calendarId: id)
        case .closeDetail: SharedSDK.CalendarListActionCloseDetail.shared
        case .rename(let id, let name): SharedSDK.CalendarListActionChangeRename(calendarId: id, name: name)
        case .setColor(let id, let color): SharedSDK.CalendarListActionChangeSetColor(calendarId: id, color: color)
        case .setNotify(let id, let notify): SharedSDK.CalendarListActionChangeSetNotify(calendarId: id, notify: notify)
        case .add(let name): SharedSDK.CalendarListActionAdd(name: name)
        case .requestDelete(let id): SharedSDK.CalendarListActionRequestDelete(calendarId: id)
        case .confirmDelete: SharedSDK.CalendarListActionConfirmDelete.shared
        case .cancelDelete: SharedSDK.CalendarListActionCancelDelete.shared
        case .openSleep: SharedSDK.CalendarListActionOpenSleep.shared
        case .dismissProblem: SharedSDK.CalendarListActionDismissProblem.shared
        }
    }

    static func effect(_ effect: any SharedSDK.CalendarListEffect) -> CalendarListEffect {
        switch onEnum(of: effect) {
        case .openSleep: .openSleep
        }
    }
}
