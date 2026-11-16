import CoreKit

/// How the Recordings feature asks the app to show something. The app owns every stack and sheet.
@MainActor
public protocol RecordingsRouting: AnyObject {

    /// The transcript of the recording `recordingId`.
    func showTranscript(recordingId: String)

    /// The page of the event `eventId`.
    func showEvent(eventId: String)

    /// The page of notes of the event `eventId`.
    func showNotes(eventId: String)

    /// The Podrobnosti sheet of the task `taskId`.
    func showTask(taskId: String)

    /// The Podrobnosti sheet of the event `eventId`.
    func showEventDetails(eventId: String)
}

/// A router for previews: it opens nothing.
@MainActor
final class PreviewRecordingsRouter: RecordingsRouting {

    // MARK: - Protocol conformance
    func showTranscript(recordingId: String) {}

    func showEvent(eventId: String) {}

    func showNotes(eventId: String) {}

    func showTask(taskId: String) {}

    func showEventDetails(eventId: String) {}
}
