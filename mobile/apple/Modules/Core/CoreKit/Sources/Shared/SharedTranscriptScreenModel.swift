@preconcurrency internal import SharedSDK

/// The Kotlin `TranscriptViewModel` as a `TranscriptScreenModel`. Releasing the bridge closes the Kotlin ViewModel,
/// which releases the player.
@MainActor
final class SharedTranscriptScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.TranscriptViewModel
    private let effectQueue: EffectQueue<TranscriptEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.TranscriptViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedTranscriptScreenModel: ScreenModel {

    var state: TranscriptState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<TranscriptState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<TranscriptEffect> {
        effectQueue.stream()
    }

    func send(_ action: TranscriptAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedTranscriptScreenModel {

    static func state(_ state: SharedSDK.TranscriptState) -> TranscriptState {
        TranscriptState(
            phase: phase(state.phase),
            failure: state.failure.map(FailureKind.init),
            title: state.title,
            date: state.date,
            durationSeconds: state.durationSeconds.map { Int($0.int32Value) },
            language: state.language,
            status: state.status.map(RecordingStatus.init),
            eventId: state.eventId,
            eventName: state.eventName,
            project: state.project.map(contextItem),
            company: state.company.map(contextItem),
            people: state.people.map(contextItem),
            summary: state.summary,
            decisions: state.decisions,
            actionItems: state.actionItems.map(actionRow),
            tab: tab(state.tab),
            query: state.query,
            segments: state.segments.map(segmentRow),
            matchCount: Int(state.matchCount),
            speakerMenu: state.speakerMenu,
            candidates: state.candidates.map {
                TranscriptCandidateRow(personId: $0.personId, name: $0.name, current: $0.current)
            },
            player: player(state.player),
            working: state.working,
            writeFailure: state.writeFailure.map(Failed.init)
        )
    }

    private static func phase(_ phase: SharedSDK.TranscriptPhase) -> TranscriptPhase {
        switch phase {
        case .loading: .loading
        case .content: .content
        case .error: .error
        }
    }

    static func tab(_ tab: SharedSDK.TranscriptTab) -> TranscriptTab {
        switch tab {
        case .summary: .summary
        case .transcript: .transcript
        }
    }

    static func sharedTab(_ tab: TranscriptTab) -> SharedSDK.TranscriptTab {
        switch tab {
        case .summary: .summary
        case .transcript: .transcript
        }
    }

    static func actionState(_ state: SharedSDK.TranscriptActionState) -> TranscriptActionState {
        switch state {
        case .open: .open
        case .added: .added
        case .noted: .noted
        case .dismissed: .dismissed
        }
    }

    private static func contextItem(_ item: SharedSDK.TranscriptContextItem) -> TranscriptContextItem {
        TranscriptContextItem(id: item.id, name: item.name, inherited: item.inherited)
    }

    private static func actionRow(_ row: SharedSDK.TranscriptActionRow) -> TranscriptActionRow {
        TranscriptActionRow(
            id: Int(row.id),
            text: row.text,
            ownerLabel: row.ownerLabel,
            due: row.due,
            state: actionState(row.state),
            isMine: row.isMine,
            busy: row.busy
        )
    }

    private static func segmentRow(_ row: SharedSDK.TranscriptSegmentRow) -> TranscriptSegmentRow {
        TranscriptSegmentRow(
            index: Int(row.index),
            speaker: row.speaker,
            label: row.label,
            text: row.text,
            startsAt: row.startsAt,
            mapped: row.mapped,
            active: row.active
        )
    }

    private static func player(_ player: SharedSDK.TranscriptPlayer) -> TranscriptPlayer {
        TranscriptPlayer(
            available: player.available,
            failed: player.failed,
            playing: player.playing,
            position: player.position,
            duration: player.duration,
            rate: player.rate
        )
    }

    static func action(_ action: TranscriptAction) -> any SharedSDK.TranscriptAction {
        switch action {
        case .retry: SharedSDK.TranscriptActionRetry.shared
        case .refresh: SharedSDK.TranscriptActionRefresh.shared
        case .selectTab(let tab): SharedSDK.TranscriptActionSelectTab(tab: sharedTab(tab))
        case .search(let query): SharedSDK.TranscriptActionSearch(query: query)
        case .seek(let seconds): SharedSDK.TranscriptActionPlayerSeek(seconds: seconds)
        case .togglePlay: SharedSDK.TranscriptActionPlayerTogglePlay.shared
        case .cycleRate: SharedSDK.TranscriptActionPlayerCycleRate.shared
        case .openSpeakerMenu(let speaker): SharedSDK.TranscriptActionSpeakerOpenMenu(speaker: speaker)
        case .closeSpeakerMenu: SharedSDK.TranscriptActionSpeakerCloseMenu.shared
        case .assignSpeaker(let personId): SharedSDK.TranscriptActionSpeakerAssign(personId: personId)
        case .addTask(let itemId): SharedSDK.TranscriptActionAddTask(itemId: Int32(itemId))
        case .follow(let itemId): SharedSDK.TranscriptActionFollow(itemId: Int32(itemId))
        case .undo(let itemId): SharedSDK.TranscriptActionUndo(itemId: Int32(itemId))
        case .openEvent: SharedSDK.TranscriptActionOpenEvent.shared
        case .dismissFailure: SharedSDK.TranscriptActionDismissFailure.shared
        }
    }

    static func effect(_ effect: any SharedSDK.TranscriptEffect) -> TranscriptEffect {
        switch onEnum(of: effect) {
        case .openEvent(let open): .openEvent(eventId: open.eventId)
        }
    }
}
