package cz.semprec.app.sdk

import cz.semprec.app.core.AudioPlayer
import cz.semprec.app.core.AudioRecorder
import cz.semprec.app.data.AuthenticatedApi
import cz.semprec.app.data.RecordingsData
import cz.semprec.app.domain.ItemRepository
import cz.semprec.app.presentation.MeetingViewModel
import cz.semprec.app.presentation.RecorderViewModel
import cz.semprec.app.presentation.RecordingsViewModel
import cz.semprec.app.presentation.RecordingsViewModelFactory
import cz.semprec.app.presentation.TranscriptViewModel

/**
 * The recordings list, the recorder, the transcript and the page of an event; [HomeSDK.recordings] hands it out.
 * [recorder] and [player] are the device's microphone and speaker.
 */
class RecordingsSDK internal constructor(private val factory: RecordingsViewModelFactory) {

    /** The recordings, newest first. */
    fun recordingsViewModel(): RecordingsViewModel = factory.recordingsViewModel()

    /** A recorder; what it records belongs to the event [eventId] when one is named. */
    fun recorderViewModel(eventId: String?): RecorderViewModel = factory.recorderViewModel(eventId)

    /** The transcript of the recording [transcriptId]. */
    fun transcriptViewModel(transcriptId: String): TranscriptViewModel = factory.transcriptViewModel(transcriptId)

    /** The page of the event [eventId]: its tasks, notes, recordings and people. */
    fun meetingViewModel(eventId: String): MeetingViewModel = factory.meetingViewModel(eventId)

    internal companion object {
        fun create(
            api: AuthenticatedApi,
            details: ItemRepository,
            recorder: AudioRecorder,
            player: AudioPlayer,
        ): RecordingsSDK {
            val data = RecordingsData(api, details)
            return RecordingsSDK(
                RecordingsViewModelFactory(data.recordings, data.transcripts, data.meetings, details, recorder, player),
            )
        }
    }
}
