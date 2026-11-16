@preconcurrency internal import SharedSDK

/// The Kotlin `MeetingViewModel` as a `MeetingScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedMeetingScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.MeetingViewModel
    private let effectQueue: EffectQueue<MeetingEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.MeetingViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedMeetingScreenModel: ScreenModel {

    var state: MeetingState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<MeetingState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<MeetingEffect> {
        effectQueue.stream()
    }

    func send(_ action: MeetingAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedMeetingScreenModel {

    static func state(_ state: SharedSDK.MeetingState) -> MeetingState {
        MeetingState(
            phase: phase(state.phase),
            failure: state.failure.map(FailureKind.init),
            title: state.title,
            place: state.place,
            date: state.date,
            endDate: state.endDate,
            timeFrom: state.timeFrom,
            timeTo: state.timeTo,
            projectName: state.projectName,
            projectColor: state.projectColor,
            companyName: state.companyName,
            people: state.people.map { MeetingPersonRow(id: $0.id, name: $0.name) },
            tasks: state.tasks.map(taskRow),
            suggestions: state.suggestions.map(suggestionRow),
            recordings: state.recordings.map(RecordingRow.init),
            working: state.working,
            writeFailure: state.writeFailure.map(Failed.init)
        )
    }

    private static func phase(_ phase: SharedSDK.MeetingPhase) -> MeetingPhase {
        switch phase {
        case .loading: .loading
        case .content: .content
        case .error: .error
        }
    }

    static func taskStatus(_ status: SharedSDK.MeetingTaskStatus) -> MeetingTaskStatus {
        switch status {
        case .open: .open
        case .missed: .missed
        case .done: .done
        case .doneElsewhere: .doneElsewhere
        case .moved: .moved
        }
    }

    private static func taskRow(_ row: SharedSDK.MeetingTaskRow) -> MeetingTaskRow {
        MeetingTaskRow(
            id: row.id,
            title: row.title,
            status: taskStatus(row.status),
            detail: row.detail,
            busy: row.busy
        )
    }

    private static func suggestionRow(_ row: SharedSDK.MeetingSuggestionRow) -> MeetingSuggestionRow {
        MeetingSuggestionRow(
            transcriptId: row.transcriptId,
            actionItemId: Int(row.actionItemId),
            text: row.text,
            ownerLabel: row.ownerLabel,
            due: row.due,
            busy: row.busy
        )
    }

    static func action(_ action: MeetingAction) -> any SharedSDK.MeetingAction {
        switch action {
        case .retry: SharedSDK.MeetingActionRetry.shared
        case .refresh: SharedSDK.MeetingActionRefresh.shared
        case .toggleTask(let taskId): SharedSDK.MeetingActionToggleTask(taskId: taskId)
        case .addTask(let title): SharedSDK.MeetingActionAddTask(title: title)
        case .addSuggestion(let transcriptId, let actionItemId):
            SharedSDK.MeetingActionAddSuggestion(transcriptId: transcriptId, actionItemId: Int32(actionItemId))
        case .openTask(let taskId): SharedSDK.MeetingActionOpenTask(taskId: taskId)
        case .openRecording(let recordingId): SharedSDK.MeetingActionOpenRecording(recordingId: recordingId)
        case .openNotes: SharedSDK.MeetingActionOpenNotes.shared
        case .openDetails: SharedSDK.MeetingActionOpenDetails.shared
        case .dismissFailure: SharedSDK.MeetingActionDismissFailure.shared
        }
    }

    static func effect(_ effect: any SharedSDK.MeetingEffect) -> MeetingEffect {
        switch onEnum(of: effect) {
        case .showTask(let show): .showTask(taskId: show.taskId)
        case .showRecording(let show): .showRecording(recordingId: show.recordingId)
        case .showNotes(let show): .showNotes(eventId: show.eventId)
        case .showDetails(let show): .showDetails(eventId: show.eventId)
        }
    }
}
