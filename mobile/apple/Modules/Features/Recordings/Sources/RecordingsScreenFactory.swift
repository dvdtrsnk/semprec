import CoreKit
import SwiftUI

/// The screens of the Recordings feature. A screen calls its `make...` closures once, when SwiftUI creates its state
/// objects, and owns the models for as long as SwiftUI keeps the screen.
@MainActor
public enum RecordingsScreenFactory {

    // MARK: - Screens
    /// The recordings, with the recorder of a recording that belongs to no event.
    public static func recordings(
        makeModel: @escaping @MainActor () -> any RecordingsScreenModel,
        makeRecorder: @escaping @MainActor () -> any RecorderScreenModel,
        router: any RecordingsRouting
    ) -> some View {
        RecordingsScreen(
            viewModel: RecordingsViewModel(model: makeModel(), router: router),
            recorder: RecorderViewModel(model: makeRecorder())
        )
    }

    /// The transcript of one recording.
    public static func transcript(
        makeModel: @escaping @MainActor () -> any TranscriptScreenModel,
        router: any RecordingsRouting
    ) -> some View {
        TranscriptScreen(viewModel: TranscriptViewModel(model: makeModel(), router: router))
    }

    /// The page of an event, with the recorder of a recording that belongs to it.
    public static func meeting(
        makeModel: @escaping @MainActor () -> any MeetingScreenModel,
        makeRecorder: @escaping @MainActor () -> any RecorderScreenModel,
        router: any RecordingsRouting
    ) -> some View {
        MeetingScreen(
            viewModel: MeetingViewModel(model: makeModel(), router: router),
            recorder: RecorderViewModel(model: makeRecorder())
        )
    }
}
