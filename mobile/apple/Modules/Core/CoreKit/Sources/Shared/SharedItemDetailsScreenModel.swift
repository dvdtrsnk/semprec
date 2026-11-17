@preconcurrency internal import SharedSDK

/// The Kotlin `ItemDetailsViewModel` as an `ItemDetailsScreenModel`. Releasing the bridge closes the Kotlin
/// ViewModel.
@MainActor
final class SharedItemDetailsScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.ItemDetailsViewModel
    private let effectQueue: EffectQueue<ItemDetailsEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.ItemDetailsViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedItemDetailsScreenModel: ScreenModel {

    var state: ItemDetailsState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<ItemDetailsState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<ItemDetailsEffect> {
        effectQueue.stream()
    }

    func send(_ action: ItemDetailsAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedItemDetailsScreenModel {

    static func state(_ state: SharedSDK.ItemDetailsState) -> ItemDetailsState {
        ItemDetailsState(
            phase: phase(state),
            kind: ItemKind(state.kind),
            title: state.title,
            done: state.done,
            description: state.description_,
            place: state.place,
            flagged: state.flagged,
            date: state.date,
            endDate: state.endDate,
            timeFrom: state.timeFrom,
            timeTo: state.timeTo,
            allDay: state.allDay,
            lengthMinutes: state.lengthMinutes.map { Int(truncating: $0) },
            repeats: TaskRepeat(state.repeat),
            project: state.project.map(ProjectRef.init),
            people: state.people.map(EntityRef.init),
            files: state.files.map(EntityRef.init),
            hostEvents: state.hostEvents.map(EntityRef.init),
            company: state.company.map(EntityRef.init),
            projectLink: state.projectLink.map(ValueLink.init),
            peopleLink: state.peopleLink.map(ValueLink.init),
            choices: choices(state.choices),
            projectChoices: state.projectChoices.map(ProjectRef.init),
            personChoices: state.personChoices.map(EntityRef.init),
            notice: state.notice.map(FailureKind.init)
        )
    }

    static func action(_ action: ItemDetailsAction) -> any SharedSDK.ItemDetailsAction {
        switch action {
        case .retry, .dismissNotice, .loadChoices, .toggleDone, .delete:
            plainAction(action)
        case .setTitle, .setDescription, .setPlace, .setFlagged, .setRepeat:
            fieldAction(action)
        case .setDate, .setTimed, .setEnded, .setTimeFrom, .setTimeTo, .setAllDay:
            scheduleAction(action)
        case .selectProject, .togglePerson, .removeFile, .unlink, .relink:
            relationAction(action)
        }
    }

    private static func plainAction(_ action: ItemDetailsAction) -> any SharedSDK.ItemDetailsAction {
        switch action {
        case .retry: SharedSDK.ItemDetailsActionRetry.shared
        case .dismissNotice: SharedSDK.ItemDetailsActionDismissNotice.shared
        case .loadChoices: SharedSDK.ItemDetailsActionLoadChoices.shared
        case .toggleDone: SharedSDK.ItemDetailsActionToggleDone.shared
        default: SharedSDK.ItemDetailsActionDelete.shared
        }
    }

    private static func fieldAction(_ action: ItemDetailsAction) -> any SharedSDK.ItemDetailsAction {
        switch action {
        case .setTitle(let title): SharedSDK.ItemDetailsActionSetTitle(title: title)
        case .setDescription(let text): SharedSDK.ItemDetailsActionSetDescription(text: text)
        case .setPlace(let text): SharedSDK.ItemDetailsActionSetPlace(text: text)
        case .setFlagged(let flagged): SharedSDK.ItemDetailsActionSetFlagged(flagged: flagged)
        default: SharedSDK.ItemDetailsActionSetRepeat(repeat: repeatOf(action).shared)
        }
    }

    private static func repeatOf(_ action: ItemDetailsAction) -> TaskRepeat {
        if case .setRepeat(let repeats) = action { return repeats }
        return .never
    }

    private static func scheduleAction(_ action: ItemDetailsAction) -> any SharedSDK.ItemDetailsAction {
        switch action {
        case .setDate(let date): SharedSDK.ItemDetailsActionSetDate(date: date)
        case .setTimed(let timed): SharedSDK.ItemDetailsActionSetTimed(timed: timed)
        case .setEnded(let ended): SharedSDK.ItemDetailsActionSetEnded(ended: ended)
        case .setTimeFrom(let time): SharedSDK.ItemDetailsActionSetTimeFrom(time: time)
        case .setTimeTo(let time): SharedSDK.ItemDetailsActionSetTimeTo(time: time)
        default: SharedSDK.ItemDetailsActionSetAllDay(allDay: allDayOf(action))
        }
    }

    private static func allDayOf(_ action: ItemDetailsAction) -> Bool {
        if case .setAllDay(let allDay) = action { return allDay }
        return false
    }

    private static func relationAction(_ action: ItemDetailsAction) -> any SharedSDK.ItemDetailsAction {
        switch action {
        case .selectProject(let id): SharedSDK.ItemDetailsActionSelectProject(projectId: id)
        case .togglePerson(let id): SharedSDK.ItemDetailsActionTogglePerson(personId: id)
        case .removeFile(let id): SharedSDK.ItemDetailsActionRemoveFile(fileId: id)
        case .unlink(let value): SharedSDK.ItemDetailsActionUnlink(value: value.shared)
        case .relink(let value): SharedSDK.ItemDetailsActionRelink(value: value.shared)
        default: SharedSDK.ItemDetailsActionRetry.shared
        }
    }

    static func effect(_ effect: any SharedSDK.ItemDetailsEffect) -> ItemDetailsEffect {
        switch onEnum(of: effect) {
        case .deleted: .deleted
        }
    }

    private static func phase(_ state: SharedSDK.ItemDetailsState) -> ItemDetailsPhase {
        switch state.phase {
        case .loading: .loading
        case .content: .content
        case .error: .failure(state.failure.map(FailureKind.init))
        }
    }

    private static func choices(_ phase: SharedSDK.ChoicesPhase) -> ChoicesPhase {
        switch phase {
        case .idle: .idle
        case .loading: .loading
        case .ready: .ready
        case .error: .failed
        }
    }
}
