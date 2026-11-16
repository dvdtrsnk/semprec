import RecordingsFeature
import SwiftUI
import TasksFeature

// MARK: - Recordings
extension AppScene {

    /// The views of the recordings, of the transcript of a recording and of the page of an event.
    @ViewBuilder
    static func recordingsDestinationView(_ destination: AppDestination, composition: AppComposition) -> some View {
        switch destination {
        case .recordings(let tab):
            RecordingsScreenFactory.recordings(
                makeModel: { composition.models.makeRecordings() },
                makeRecorder: { composition.models.makeRecorder(eventId: nil) },
                router: composition.recordingsRouter(in: tab)
            )
        case .transcript(let recordingId, let tab):
            RecordingsScreenFactory.transcript(
                makeModel: { composition.models.makeTranscript(transcriptId: recordingId) },
                router: composition.recordingsRouter(in: tab)
            )
        case .meeting(let eventId, let tab):
            RecordingsScreenFactory.meeting(
                makeModel: { composition.models.makeMeeting(eventId: eventId) },
                makeRecorder: { composition.models.makeRecorder(eventId: eventId) },
                router: composition.recordingsRouter(in: tab)
            )
        default:
            EmptyView()
        }
    }
}

// MARK: - Event page
extension AppScene {

    /// The Podrobnosti sheet of a task or an event; an event shows the row that opens its page.
    @MainActor
    static func detailsView(_ target: ItemDetailsTarget, composition: AppComposition) -> some View {
        TasksScreenFactory.details(
            makeModel: { composition.models.makeItemDetails(kind: target.kind, itemId: target.id) },
            openEventPage: eventPageOpener(for: target, composition: composition)
        )
    }

    /// What the Podrobnosti sheet of an event calls to open the page of the event: it pushes the page onto the stack
    /// the sheet was presented over. A task, and an event whose sheet knows no stack, have no such page.
    @MainActor
    static func eventPageOpener(
        for target: ItemDetailsTarget,
        composition: AppComposition
    ) -> (@MainActor () -> Void)? {
        guard target.kind == .event, let tab = target.tab else { return nil }
        let eventId = target.id
        return { [weak composition] in
            composition?.navigation.push(.meeting(eventId: eventId, tab: tab), in: tab)
        }
    }
}
