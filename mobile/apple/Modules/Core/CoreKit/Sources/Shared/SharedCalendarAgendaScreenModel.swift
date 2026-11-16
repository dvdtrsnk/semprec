@preconcurrency internal import SharedSDK

/// The Kotlin `CalendarAgendaViewModel` as a `CalendarAgendaScreenModel`. Releasing the bridge closes the Kotlin
/// ViewModel.
@MainActor
final class SharedCalendarAgendaScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.CalendarAgendaViewModel
    private let effectQueue: EffectQueue<CalendarAgendaEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.CalendarAgendaViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedCalendarAgendaScreenModel: ScreenModel {

    var state: CalendarAgendaState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<CalendarAgendaState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<CalendarAgendaEffect> {
        effectQueue.stream()
    }

    func send(_ action: CalendarAgendaAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedCalendarAgendaScreenModel {

    static func state(_ state: SharedSDK.CalendarAgendaState) -> CalendarAgendaState {
        CalendarAgendaState(
            phase: phase(state.phase, failure: state.failure),
            days: state.days.map { day in
                CalendarAgendaDay(day: day.day, entries: day.entries.map(entry))
            },
            hasMore: state.hasMore,
            loadingMore: state.loadingMore,
            moreFailure: state.moreFailure.map(Failed.init)
        )
    }

    static func phase(_ phase: SharedSDK.CalendarAgendaPhase, failure: SharedSDK.FailureKind?) -> CalendarAgendaPhase {
        switch phase {
        case .loading: .loading
        case .content: .content
        case .error: .failure(failure.map(FailureKind.init))
        }
    }

    static func entry(_ entry: SharedSDK.CalendarAgendaEntry) -> CalendarAgendaEntry {
        CalendarAgendaEntry(
            id: entry.id,
            kind: kind(entry.kind),
            title: entry.title,
            timeFrom: entry.timeFrom,
            timeTo: entry.timeTo,
            allDay: entry.allDay,
            done: entry.done,
            place: entry.place
        )
    }

    static func kind(_ kind: SharedSDK.CalendarAgendaKind) -> CalendarAgendaKind {
        switch kind {
        case .event: .event
        case .task: .task
        }
    }

    static func action(_ action: CalendarAgendaAction) -> any SharedSDK.CalendarAgendaAction {
        switch action {
        case .retry: SharedSDK.CalendarAgendaActionRetry.shared
        case .loadMore: SharedSDK.CalendarAgendaActionLoadMore.shared
        case .open(let id): SharedSDK.CalendarAgendaActionOpen(id: id)
        }
    }

    static func effect(_ effect: any SharedSDK.CalendarAgendaEffect) -> CalendarAgendaEffect {
        switch onEnum(of: effect) {
        case .openDetails(let open): .openDetails(kind: kind(open.kind), id: open.id)
        }
    }
}
