import Foundation

/// Where a recording is on its way to a transcript.
public enum RecordingStatus: Equatable, Sendable {

    case recording
    case processing
    case done
    case error
}

/// How a recording relates to an event; `unpaired` belongs to none and no question about it is open.
public enum RecordingPairing: Equatable, Sendable {

    case processing
    case event
    case awaitingEvent
    case unpaired
}

public enum RecordingsPhase: Equatable, Sendable {

    case loading
    case content
    case error
}

/// One recording of a list; `date` is an ISO date-time and `eventName` is set while it belongs to an event.
public struct RecordingRow: Equatable, Sendable, Identifiable {

    public let id: String
    public let name: String
    public let date: String?
    public let durationSeconds: Int?
    public let status: RecordingStatus?
    public let pairing: RecordingPairing
    public let eventName: String?
    public let shortSummary: String?
    public let processing: Bool

    public init(
        id: String,
        name: String,
        date: String?,
        durationSeconds: Int?,
        status: RecordingStatus?,
        pairing: RecordingPairing,
        eventName: String?,
        shortSummary: String?,
        processing: Bool
    ) {
        self.id = id
        self.name = name
        self.date = date
        self.durationSeconds = durationSeconds
        self.status = status
        self.pairing = pairing
        self.eventName = eventName
        self.shortSummary = shortSummary
        self.processing = processing
    }
}

public struct RecordingsState: Equatable, Sendable {

    public var phase: RecordingsPhase
    public var failure: FailureKind?
    public var recordings: [RecordingRow]

    public init(
        phase: RecordingsPhase = .loading,
        failure: FailureKind? = nil,
        recordings: [RecordingRow] = []
    ) {
        self.phase = phase
        self.failure = failure
        self.recordings = recordings
    }
}

public enum RecordingsAction: Equatable, Sendable {

    case retry
    case refresh
    case open(recordingId: String)
}

public enum RecordingsEffect: Equatable, Sendable {

    case openTranscript(recordingId: String)
}

public typealias RecordingsScreenModel = ScreenModel<RecordingsState, RecordingsAction, RecordingsEffect>

/// Recordings screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedRecordingsScreenModel =
    ScriptedScreenModel<RecordingsState, RecordingsAction, RecordingsEffect>
