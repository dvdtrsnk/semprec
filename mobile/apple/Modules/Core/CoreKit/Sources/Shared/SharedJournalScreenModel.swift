@preconcurrency internal import SharedSDK

/// The Kotlin `JournalViewModel` as a `JournalScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedJournalScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.JournalViewModel
    private let effectQueue: EffectQueue<JournalEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.JournalViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedJournalScreenModel: ScreenModel {

    var state: JournalState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<JournalState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<JournalEffect> {
        effectQueue.stream()
    }

    func send(_ action: JournalAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedJournalScreenModel {

    static func state(_ state: SharedSDK.JournalState) -> JournalState {
        JournalState(
            phase: JournalPhase(state.phase, failure: state.failure),
            selection: JournalSelection(state.selection),
            today: state.today,
            axis: state.axis.map(JournalAxisRow.init),
            page: state.page.map(JournalPage.init),
            weeks: state.weeks.map(JournalWeek.init),
            events: state.events.map(JournalEvent.init),
            birthdays: state.birthdays.map(JournalBirthday.init),
            inbox: state.inbox.map(JournalInboxItem.init)
        )
    }

    static func action(_ action: JournalAction) -> any SharedSDK.JournalAction {
        switch action {
        case .retry: SharedSDK.JournalActionRetry.shared
        case .select(let kind, let start): SharedSDK.JournalActionSelect(kind: kind.shared, start: start)
        case .goToday: SharedSDK.JournalActionGoToday.shared
        case .showAxisAround(let day): SharedSDK.JournalActionShowAxisAround(day: day)
        case .openEvent(let id): SharedSDK.JournalActionOpenEvent(id: id)
        case .openInbox: SharedSDK.JournalActionOpenInbox.shared
        }
    }

    static func effect(_ effect: any SharedSDK.JournalEffect) -> JournalEffect {
        switch onEnum(of: effect) {
        case .openEvent(let openEvent): .openEvent(id: openEvent.id)
        case .openInbox: .openInbox
        }
    }
}
