import RecordingsFeature

/// Routes of the Recordings feature, on the stack of the tab its screen was created for: a transcript and the page of
/// an event push onto that stack, and the Podrobnosti sheet of a task or an event is presented over it.
@MainActor
final class AppRecordingsRouter {

    // MARK: - Dependencies
    private let context: NavigationContext
    private let tab: AppTab

    // MARK: - Init
    init(context: NavigationContext, tab: AppTab) {
        self.context = context
        self.tab = tab
    }
}

// MARK: - Protocol conformance
extension AppRecordingsRouter: RecordingsRouting {

    func showTranscript(recordingId: String) {
        context.push(.transcript(recordingId: recordingId, tab: tab), in: tab)
    }

    func showEvent(eventId: String) {
        context.push(.meeting(eventId: eventId, tab: tab), in: tab)
    }

    func showNotes(eventId: String) {
        context.push(.notes(itemId: eventId, tab: tab), in: tab)
    }

    func showTask(taskId: String) {
        context.showDetails(kind: .task, id: taskId, from: tab)
    }

    func showEventDetails(eventId: String) {
        context.showDetails(kind: .event, id: eventId, from: tab)
    }
}
