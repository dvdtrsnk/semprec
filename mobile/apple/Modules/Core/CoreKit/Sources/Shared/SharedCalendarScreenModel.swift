@preconcurrency internal import SharedSDK

/// The Kotlin `CalendarViewModel` as a `CalendarScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedCalendarScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.CalendarViewModel
    private let effectQueue: EffectQueue<CalendarEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.CalendarViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedCalendarScreenModel: ScreenModel {

    var state: CalendarState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<CalendarState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<CalendarEffect> {
        effectQueue.stream()
    }

    func send(_ action: CalendarAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedCalendarScreenModel {

    static func state(_ state: SharedSDK.CalendarState) -> CalendarState {
        CalendarState(
            phase: CalendarPhase(state.phase, failure: state.failure),
            zoom: CalendarZoom(state.zoom),
            selectedDay: state.selectedDay,
            today: state.today,
            nowMinutes: Int(state.nowMinutes),
            timezone: state.timezone,
            days: state.days.map(CalendarDayState.init),
            monthGrid: state.monthGrid,
            months: state.months.map(CalendarMonthState.init),
            pendingInvitations: Int(state.pendingInvitations),
            selectedItemId: state.selectedItemId,
            drag: state.drag.map(CalendarDrag.init),
            sleepDrag: state.sleepDrag.map(CalendarSleepDrag.init),
            clipboard: state.clipboard.map(CalendarClipboard.init),
            busy: state.busy,
            problem: state.problem,
            problemFailure: state.problemFailure.map(FailureKind.init)
        )
    }

    static func action(_ action: CalendarAction) -> any SharedSDK.CalendarAction {
        switch action {
        case .navigation(let navigation): Self.navigation(navigation)
        case .gesture(let gesture): Self.gesture(gesture)
        case .edit(let edit): Self.edit(edit)
        case .open(let open): Self.open(open)
        }
    }

    static func effect(_ effect: any SharedSDK.CalendarEffect) -> CalendarEffect {
        switch onEnum(of: effect) {
        case .openDetails(let details):
            .openDetails(itemId: details.itemId, kind: CalendarItemKind(details.kind), day: details.day)
        case .openCalendars: .openCalendars
        case .openInvitations: .openInvitations
        case .openNewItem(let item): .openNewItem(day: item.day)
        case .openSleep(let sleep): .openSleep(night: sleep.night)
        case .openAgenda(let agenda): .openAgenda(day: agenda.day)
        }
    }
}

// MARK: - Action groups
private extension SharedCalendarScreenModel {

    static func navigation(_ action: CalendarNavigation) -> any SharedSDK.CalendarAction {
        switch action {
        case .retry: SharedSDK.CalendarActionNavigationRetry.shared
        case .refresh: SharedSDK.CalendarActionNavigationRefresh.shared
        case .show(let zoom, let day): SharedSDK.CalendarActionNavigationShow(zoom: zoom.shared, day: day)
        case .page(let steps): SharedSDK.CalendarActionNavigationPage(steps: Int32(steps))
        case .goToday: SharedSDK.CalendarActionNavigationGoToday.shared
        }
    }

    static func gesture(_ action: CalendarGesture) -> any SharedSDK.CalendarAction {
        switch action {
        case .tap(let id): SharedSDK.CalendarActionGestureTap(itemId: id)
        case .tapBackground: SharedSDK.CalendarActionGestureTapBackground.shared
        case .select(let id): SharedSDK.CalendarActionGestureSelect(itemId: id)
        case .toggleDone(let id, let inEventId):
            SharedSDK.CalendarActionGestureToggleDone(itemId: id, inEventId: inEventId)
        case .dragMove(let id, let day, let rawStart, let overAllDayRow, let overEventId):
            SharedSDK.CalendarActionGestureDragMove(
                itemId: id,
                day: day,
                rawStart: Int32(rawStart),
                overAllDayRow: overAllDayRow,
                overEventId: overEventId
            )
        case .dragResize(let id, let edge, let raw):
            SharedSDK.CalendarActionGestureDragResize(itemId: id, edge: edge.shared, rawMinutes: Int32(raw))
        case .endDrag(let commit): SharedSDK.CalendarActionGestureEndDrag(commit: commit)
        case .sleepDrag(let night, let edge, let delta):
            SharedSDK.CalendarActionGestureSleepDrag(night: night, edge: edge?.shared, deltaMinutes: Int32(delta))
        case .endSleepDrag(let commit): SharedSDK.CalendarActionGestureEndSleepDrag(commit: commit)
        case .moveToDay(let id, let day): SharedSDK.CalendarActionGestureMoveToDay(itemId: id, day: day)
        }
    }

    static func edit(_ action: CalendarEdit) -> any SharedSDK.CalendarAction {
        switch action {
        case .cut(let id): SharedSDK.CalendarActionEditCut(itemId: id)
        case .copy(let id): SharedSDK.CalendarActionEditCopy(itemId: id)
        case .duplicate(let id): SharedSDK.CalendarActionEditDuplicate(itemId: id)
        case .paste(let day, let rawStart, let allDay):
            SharedSDK.CalendarActionEditPaste(day: day, rawStart: Int32(rawStart), allDay: allDay)
        case .delete(let id): SharedSDK.CalendarActionEditDelete(itemId: id)
        case .dismissProblem: SharedSDK.CalendarActionEditDismissProblem.shared
        }
    }

    static func open(_ action: CalendarOpen) -> any SharedSDK.CalendarAction {
        switch action {
        case .calendars: SharedSDK.CalendarActionOpenCalendars.shared
        case .invitations: SharedSDK.CalendarActionOpenInvitations.shared
        case .newItem(let day): SharedSDK.CalendarActionOpenNewItem(day: day)
        case .sleep(let night): SharedSDK.CalendarActionOpenSleep(night: night)
        case .agenda(let day): SharedSDK.CalendarActionOpenAgenda(day: day)
        }
    }
}
