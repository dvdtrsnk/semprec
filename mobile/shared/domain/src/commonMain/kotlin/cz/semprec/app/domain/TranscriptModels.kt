package cz.semprec.app.domain

import cz.semprec.app.core.PlaybackSource
import cz.semprec.app.core.RecordingStatus
import cz.semprec.app.core.TranscriptActionState

/** A voice of a transcript: [key] is what its segments name, [label] what the person reads (a name or "Speaker 3"). */
data class TranscriptSpeaker(val key: String, val ordinal: Int, val label: String, val personId: String?)

/** What one speaker said between [startsAt] and [endsAt] seconds of the recording. */
data class TranscriptSegment(
    val index: Int,
    val speaker: String,
    val label: String,
    val text: String,
    val startsAt: Double,
    val endsAt: Double,
)

/** One action item of the meeting notes; [due] is what the notes say and [taskId] is the task made of it. */
data class TranscriptActionItem(
    val id: Int,
    val text: String,
    val ownerLabel: String?,
    val due: String?,
    val state: TranscriptActionState,
    val taskId: String?,
    val isMine: Boolean,
)

/** The meeting notes Semp wrote from the recording. */
data class TranscriptNotes(
    val summary: String,
    val decisions: List<String>,
    val actionItems: List<TranscriptActionItem>,
)

/** The event a transcript belongs to. */
data class TranscriptEventRef(val id: String, val name: String?)

/** A project, company or person of the transcript; [inherited] is true while it follows the event. */
data class TranscriptContextValue(val id: String, val name: String, val inherited: Boolean)

data class TranscriptContext(
    val project: TranscriptContextValue?,
    val company: TranscriptContextValue?,
    val people: List<TranscriptContextValue>,
)

/** A transcript with everything its screen shows. [blobId] is the audio, when the server still has it. */
data class TranscriptDetail(
    val id: String,
    val name: String,
    val date: String?,
    val durationSeconds: Int?,
    val language: String?,
    val status: RecordingStatus?,
    val speakers: List<TranscriptSpeaker>,
    val segments: List<TranscriptSegment>,
    val notes: TranscriptNotes?,
    val event: TranscriptEventRef?,
    val context: TranscriptContext,
    val blobId: String?,
)

/** A person a speaker of the transcript can be: a participant of its event. */
data class TranscriptCandidate(val personId: String, val name: String, val mappedSpeaker: String?)

/** The transcript of a recording, its speakers and its action items. */
interface TranscriptRepository {
    suspend fun detail(transcriptId: String): RepositoryResult<TranscriptDetail>

    suspend fun candidates(transcriptId: String): RepositoryResult<List<TranscriptCandidate>>

    /** Says who [speaker] is; `null` takes the assignment back. */
    suspend fun assignSpeaker(transcriptId: String, speaker: String, personId: String?): RepositoryResult<Unit>

    /** Follows the action item without making a task of it, or (`false`) makes it open again. */
    suspend fun note(transcriptId: String, actionItemId: Int, noted: Boolean): RepositoryResult<Unit>

    /** Makes a task of the action item. */
    suspend fun addTask(transcriptId: String, actionItemId: Int): RepositoryResult<Unit>

    /** Takes back the task made of the action item. */
    suspend fun removeTask(transcriptId: String, actionItemId: Int): RepositoryResult<Unit>

    /** Where the audio of a transcript streams from and how it is let in. */
    suspend fun playback(blobId: String): RepositoryResult<PlaybackSource>
}
