package cz.alldots.app.presentation

import cz.alldots.app.core.AudioPlayer
import cz.alldots.app.core.AudioRecorder
import cz.alldots.app.domain.ItemRepository
import cz.alldots.app.domain.MeetingRepository
import cz.alldots.app.domain.RecordingsRepository
import cz.alldots.app.domain.TranscriptRepository
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the recording, transcript and meeting screens, whose constructors are internal, for the SDK in the umbrella
 * module. Hidden from Objective-C and Swift so that the domain ports it takes stay out of the exported native API.
 * [recorder] and [player] are the device's microphone and speaker, shared by every screen the factory makes.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class RecordingsViewModelFactory(
    private val recordings: RecordingsRepository,
    private val transcripts: TranscriptRepository,
    private val meetings: MeetingRepository,
    private val details: ItemRepository,
    private val recorder: AudioRecorder,
    private val player: AudioPlayer,
    private val changes: Flow<Unit> = emptyFlow(),
) {
    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun recordingsViewModel(): RecordingsViewModel = RecordingsViewModel(recordings, changes)

    /** The recorder; its recording belongs to [eventId] when one is named. */
    fun recorderViewModel(eventId: String?): RecorderViewModel = RecorderViewModel(eventId, recorder, recordings)

    fun transcriptViewModel(transcriptId: String): TranscriptViewModel =
        TranscriptViewModel(transcriptId, transcripts, player)

    fun meetingViewModel(eventId: String): MeetingViewModel =
        MeetingViewModel(eventId, details, meetings, recordings, transcripts, changes)
}
