import Foundation

public enum TranscriptPhase: Equatable, Sendable {

    case loading
    case content
    case error
}

public enum TranscriptTab: Equatable, Sendable {

    case summary
    case transcript
}

/// What became of an action item: a task was made of it (`added`), the person follows it (`noted`).
public enum TranscriptActionState: Equatable, Sendable {

    case open
    case added
    case noted
    case dismissed
}

/// A project, company or person of the transcript; `inherited` is true while it follows the event.
public struct TranscriptContextItem: Equatable, Sendable, Identifiable {

    public let id: String
    public let name: String
    public let inherited: Bool

    public init(id: String, name: String, inherited: Bool) {
        self.id = id
        self.name = name
        self.inherited = inherited
    }
}

public struct TranscriptActionRow: Equatable, Sendable, Identifiable {

    public let id: Int
    public let text: String
    public let ownerLabel: String?
    public let due: String?
    public let state: TranscriptActionState
    public let isMine: Bool
    public let busy: Bool

    public init(
        id: Int,
        text: String,
        ownerLabel: String?,
        due: String?,
        state: TranscriptActionState,
        isMine: Bool,
        busy: Bool
    ) {
        self.id = id
        self.text = text
        self.ownerLabel = ownerLabel
        self.due = due
        self.state = state
        self.isMine = isMine
        self.busy = busy
    }
}

/// What one voice said at `startsAt` seconds; `mapped` is false while the voice is nobody yet.
public struct TranscriptSegmentRow: Equatable, Sendable, Identifiable {

    public let index: Int
    public let speaker: String
    public let label: String
    public let text: String
    public let startsAt: Double
    public let mapped: Bool
    public let active: Bool

    public var id: Int { index }

    public init(
        index: Int,
        speaker: String,
        label: String,
        text: String,
        startsAt: Double,
        mapped: Bool,
        active: Bool
    ) {
        self.index = index
        self.speaker = speaker
        self.label = label
        self.text = text
        self.startsAt = startsAt
        self.mapped = mapped
        self.active = active
    }
}

/// A person the open voice can be given to.
public struct TranscriptCandidateRow: Equatable, Sendable, Identifiable {

    public let personId: String
    public let name: String
    public let current: Bool

    public var id: String { personId }

    public init(personId: String, name: String, current: Bool) {
        self.personId = personId
        self.name = name
        self.current = current
    }
}

/// The player; times are seconds.
public struct TranscriptPlayer: Equatable, Sendable {

    public var available: Bool
    public var failed: Bool
    public var playing: Bool
    public var position: Double
    public var duration: Double
    public var rate: Float

    public init(
        available: Bool = false,
        failed: Bool = false,
        playing: Bool = false,
        position: Double = 0,
        duration: Double = 0,
        rate: Float = 1
    ) {
        self.available = available
        self.failed = failed
        self.playing = playing
        self.position = position
        self.duration = duration
        self.rate = rate
    }
}

public struct TranscriptState: Equatable, Sendable {

    public var phase: TranscriptPhase
    public var failure: FailureKind?
    public var title: String
    public var date: String?
    public var durationSeconds: Int?
    public var language: String?
    public var status: RecordingStatus?
    public var eventId: String?
    public var eventName: String?
    public var project: TranscriptContextItem?
    public var company: TranscriptContextItem?
    public var people: [TranscriptContextItem]
    public var summary: String?
    public var decisions: [String]
    public var actionItems: [TranscriptActionRow]
    public var tab: TranscriptTab
    public var query: String
    public var segments: [TranscriptSegmentRow]
    public var matchCount: Int
    public var speakerMenu: String?
    public var candidates: [TranscriptCandidateRow]
    public var player: TranscriptPlayer
    public var working: Bool
    public var writeFailure: Failed?

    public init(
        phase: TranscriptPhase = .loading,
        failure: FailureKind? = nil,
        title: String = "",
        date: String? = nil,
        durationSeconds: Int? = nil,
        language: String? = nil,
        status: RecordingStatus? = nil,
        eventId: String? = nil,
        eventName: String? = nil,
        project: TranscriptContextItem? = nil,
        company: TranscriptContextItem? = nil,
        people: [TranscriptContextItem] = [],
        summary: String? = nil,
        decisions: [String] = [],
        actionItems: [TranscriptActionRow] = [],
        tab: TranscriptTab = .summary,
        query: String = "",
        segments: [TranscriptSegmentRow] = [],
        matchCount: Int = 0,
        speakerMenu: String? = nil,
        candidates: [TranscriptCandidateRow] = [],
        player: TranscriptPlayer = TranscriptPlayer(),
        working: Bool = false,
        writeFailure: Failed? = nil
    ) {
        self.phase = phase
        self.failure = failure
        self.title = title
        self.date = date
        self.durationSeconds = durationSeconds
        self.language = language
        self.status = status
        self.eventId = eventId
        self.eventName = eventName
        self.project = project
        self.company = company
        self.people = people
        self.summary = summary
        self.decisions = decisions
        self.actionItems = actionItems
        self.tab = tab
        self.query = query
        self.segments = segments
        self.matchCount = matchCount
        self.speakerMenu = speakerMenu
        self.candidates = candidates
        self.player = player
        self.working = working
        self.writeFailure = writeFailure
    }
}

public enum TranscriptAction: Equatable, Sendable {

    case retry
    case refresh
    case selectTab(TranscriptTab)
    case search(String)
    case seek(seconds: Double)
    case togglePlay
    case cycleRate
    case openSpeakerMenu(speaker: String)
    case closeSpeakerMenu
    case assignSpeaker(personId: String?)
    case addTask(itemId: Int)
    case follow(itemId: Int)
    case undo(itemId: Int)
    case openEvent
    case dismissFailure
}

public enum TranscriptEffect: Equatable, Sendable {

    case openEvent(eventId: String)
}

public typealias TranscriptScreenModel = ScreenModel<TranscriptState, TranscriptAction, TranscriptEffect>

/// Transcript screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedTranscriptScreenModel =
    ScriptedScreenModel<TranscriptState, TranscriptAction, TranscriptEffect>
