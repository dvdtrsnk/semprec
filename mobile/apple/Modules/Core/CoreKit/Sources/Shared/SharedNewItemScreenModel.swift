@preconcurrency internal import SharedSDK

/// The Kotlin `NewCalendarItemViewModel` as a `NewItemScreenModel`. Releasing the bridge closes the ViewModel.
@MainActor
final class SharedNewItemScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.NewCalendarItemViewModel
    private let effectQueue: EffectQueue<NewItemEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.NewCalendarItemViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedNewItemScreenModel: ScreenModel {

    var state: NewItemState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<NewItemState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<NewItemEffect> {
        effectQueue.stream()
    }

    func send(_ action: NewItemAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedNewItemScreenModel {

    static func state(_ state: SharedSDK.NewItemState) -> NewItemState {
        NewItemState(
            phase: NewItemPhase(state.phase, failure: state.failure),
            calendars: state.calendars.map(NewItemCalendar.init),
            defaultDay: state.defaultDay
        )
    }

    static func action(_ action: NewItemAction) -> any SharedSDK.NewItemAction {
        switch action {
        case .create(let draft):
            SharedSDK.NewItemActionCreate(
                kind: draft.kind.shared,
                title: draft.title,
                day: draft.day,
                timed: draft.timed,
                startMinutes: Int32(draft.startMinutes),
                hasEnd: draft.hasEnd,
                endMinutes: Int32(draft.endMinutes),
                place: draft.place,
                calendarId: draft.calendarId,
                endDay: draft.endDay,
                notes: draft.notes,
                url: draft.url,
                alertMinutes: draft.alertMinutes.map { KotlinInt(int: Int32($0)) },
                travelMinutes: draft.travelMinutes.map { KotlinInt(int: Int32($0)) },
                repeat: draft.repeatRule.shared,
                flagged: draft.flagged
            )
        case .edited: SharedSDK.NewItemActionEdited.shared
        }
    }

    static func effect(_ effect: any SharedSDK.NewItemEffect) -> NewItemEffect {
        switch onEnum(of: effect) {
        case .created(let created): .created(itemId: created.itemId)
        }
    }
}
