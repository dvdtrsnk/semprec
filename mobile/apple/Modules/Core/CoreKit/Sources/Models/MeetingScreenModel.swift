import Foundation

public enum MeetingPhase: Equatable, Sendable {

    case loading
    case content
    case error
}

/// How a task stands in the event: finished elsewhere, moved to a later event, or still open although it is over.
public enum MeetingTaskStatus: Equatable, Sendable {

    case open
    case missed
    case done
    case doneElsewhere
    case moved
}

/// A task of the event; `detail` is the day it was finished on or the event it went to.
public struct MeetingTaskRow: Equatable, Sendable, Identifiable {

    public let id: String
    public let title: String
    public let status: MeetingTaskStatus
    public let detail: String?
    public let busy: Bool

    public init(id: String, title: String, status: MeetingTaskStatus, detail: String?, busy: Bool) {
        self.id = id
        self.title = title
        self.status = status
        self.detail = detail
        self.busy = busy
    }
}

/// An action item of the event's transcripts that can become a task.
public struct MeetingSuggestionRow: Equatable, Sendable, Identifiable {

    public let transcriptId: String
    public let actionItemId: Int
    public let text: String
    public let ownerLabel: String?
    public let due: String?
    public let busy: Bool

    public var id: String { "\(transcriptId)#\(actionItemId)" }

    public init(
        transcriptId: String,
        actionItemId: Int,
        text: String,
        ownerLabel: String?,
        due: String?,
        busy: Bool
    ) {
        self.transcriptId = transcriptId
        self.actionItemId = actionItemId
        self.text = text
        self.ownerLabel = ownerLabel
        self.due = due
        self.busy = busy
    }
}

public struct MeetingPersonRow: Equatable, Sendable, Identifiable {

    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/// The page of an event. `date` and `endDate` are `YYYY-MM-DD`, `timeFrom` and `timeTo` `HH:MM`; no `timeFrom` is an
/// all-day event.
public struct MeetingState: Equatable, Sendable {

    public var phase: MeetingPhase
    public var failure: FailureKind?
    public var title: String
    public var place: String
    public var date: String?
    public var endDate: String?
    public var timeFrom: String?
    public var timeTo: String?
    public var projectName: String?
    public var projectColor: String?
    public var companyName: String?
    public var people: [MeetingPersonRow]
    public var tasks: [MeetingTaskRow]
    public var suggestions: [MeetingSuggestionRow]
    public var recordings: [RecordingRow]
    public var working: Bool
    public var writeFailure: Failed?

    public init(
        phase: MeetingPhase = .loading,
        failure: FailureKind? = nil,
        title: String = "",
        place: String = "",
        date: String? = nil,
        endDate: String? = nil,
        timeFrom: String? = nil,
        timeTo: String? = nil,
        projectName: String? = nil,
        projectColor: String? = nil,
        companyName: String? = nil,
        people: [MeetingPersonRow] = [],
        tasks: [MeetingTaskRow] = [],
        suggestions: [MeetingSuggestionRow] = [],
        recordings: [RecordingRow] = [],
        working: Bool = false,
        writeFailure: Failed? = nil
    ) {
        self.phase = phase
        self.failure = failure
        self.title = title
        self.place = place
        self.date = date
        self.endDate = endDate
        self.timeFrom = timeFrom
        self.timeTo = timeTo
        self.projectName = projectName
        self.projectColor = projectColor
        self.companyName = companyName
        self.people = people
        self.tasks = tasks
        self.suggestions = suggestions
        self.recordings = recordings
        self.working = working
        self.writeFailure = writeFailure
    }
}

public enum MeetingAction: Equatable, Sendable {

    case retry
    case refresh
    case toggleTask(taskId: String)
    case addTask(title: String)
    case addSuggestion(transcriptId: String, actionItemId: Int)
    case openTask(taskId: String)
    case openRecording(recordingId: String)
    case openNotes
    case openDetails
    case dismissFailure
}

/// Where the page asks the app to go.
public enum MeetingEffect: Equatable, Sendable {

    case showTask(taskId: String)
    case showRecording(recordingId: String)
    case showNotes(eventId: String)
    case showDetails(eventId: String)
}

public typealias MeetingScreenModel = ScreenModel<MeetingState, MeetingAction, MeetingEffect>

/// Meeting screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedMeetingScreenModel = ScriptedScreenModel<MeetingState, MeetingAction, MeetingEffect>
