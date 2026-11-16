package cz.semprec.app.domain

import cz.semprec.app.core.CapturedAudio
import cz.semprec.app.core.RecordingPairing
import cz.semprec.app.core.RecordingStatus

/**
 * One recording in a list: the server names it ([name] is the person's name, else the event's, else the time it was
 * made) and says how far it is and which event it belongs to. [date] is an ISO date-time.
 */
data class RecordingEntry(
    val id: String,
    val name: String,
    val date: String?,
    val durationSeconds: Int?,
    val status: RecordingStatus?,
    val pairing: RecordingPairing,
    val eventId: String?,
    val eventName: String?,
    val shortSummary: String?,
)

/** The recordings and the way to make one. */
interface RecordingsRepository {
    /** The newest recordings, of the event [eventId] when one is named. */
    suspend fun list(eventId: String?): RepositoryResult<List<RecordingEntry>>

    /**
     * Sends the file of [audio] to the server, which transcribes it; it belongs to the event [eventId] when one is
     * named, else the server pairs it with the event that was running.
     */
    suspend fun upload(audio: CapturedAudio, eventId: String?): RepositoryResult<Unit>
}
