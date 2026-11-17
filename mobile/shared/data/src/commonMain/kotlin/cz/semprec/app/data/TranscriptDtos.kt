package cz.semprec.app.data

import cz.semprec.app.core.RecordingStatus
import cz.semprec.app.core.TranscriptActionState
import cz.semprec.app.domain.TranscriptActionItem
import cz.semprec.app.domain.TranscriptCandidate
import cz.semprec.app.domain.TranscriptContext
import cz.semprec.app.domain.TranscriptContextValue
import cz.semprec.app.domain.TranscriptDetail
import cz.semprec.app.domain.TranscriptEventRef
import cz.semprec.app.domain.TranscriptNotes
import cz.semprec.app.domain.TranscriptSegment
import cz.semprec.app.domain.TranscriptSpeaker
import kotlinx.serialization.Serializable

/** `GET /api/transcripts/:id`. */
@Serializable
internal data class TranscriptDetailDto(
    val id: String,
    val displayName: String = "",
    val date: String? = null,
    val durationSeconds: Double? = null,
    val language: String? = null,
    val speakers: List<TranscriptSpeakerDto> = emptyList(),
    val segments: List<TranscriptSegmentDto> = emptyList(),
    val meetingNotes: TranscriptNotesDto? = null,
    val event: TranscriptEventDto? = null,
    val context: TranscriptContextDto = TranscriptContextDto(),
    val playback: TranscriptPlaybackDto? = null,
    val automation: TranscriptAutomationDto? = null,
)

@Serializable
internal data class TranscriptSpeakerDto(
    val speaker: String,
    val ordinal: Int = 0,
    val label: String = "",
    val personId: String? = null,
)

@Serializable
internal data class TranscriptSegmentDto(
    val index: Int,
    val speaker: String,
    val label: String = "",
    val text: String = "",
    val startsAt: Double = 0.0,
    val endsAt: Double = 0.0,
)

@Serializable
internal data class TranscriptNotesDto(
    val summary: String = "",
    val decisions: List<String> = emptyList(),
    val actionItems: List<TranscriptActionItemDto> = emptyList(),
)

@Serializable
internal data class TranscriptActionItemDto(
    val id: Int,
    val text: String = "",
    val ownerLabel: String? = null,
    val due: String? = null,
    val state: String = "open",
    val taskId: String? = null,
    val isMine: Boolean = false,
)

@Serializable
internal data class TranscriptEventDto(val id: String, val name: String? = null)

@Serializable
internal data class TranscriptContextDto(
    val project: TranscriptContextValueDto? = null,
    val company: TranscriptContextValueDto? = null,
    val people: List<TranscriptContextValueDto> = emptyList(),
)

/** A project, company or person of a transcript; a person is named by [personId], the others by [id]. */
@Serializable
internal data class TranscriptContextValueDto(
    val id: String? = null,
    val personId: String? = null,
    val name: String? = null,
    val valueKind: String = "own",
)

@Serializable
internal data class TranscriptPlaybackDto(val blobId: String)

@Serializable
internal data class TranscriptAutomationDto(val status: String = "")

/** `GET /api/transcripts/:id/speaker-candidates`. */
@Serializable
internal data class TranscriptCandidatesDto(val participants: List<TranscriptCandidateDto> = emptyList())

@Serializable
internal data class TranscriptCandidateDto(
    val personId: String,
    val name: String? = null,
    val mappedSpeaker: String? = null,
)

internal fun TranscriptDetailDto.toDetail(): TranscriptDetail = TranscriptDetail(
    id = id,
    name = displayName,
    date = date,
    durationSeconds = durationSeconds?.toInt(),
    language = language,
    status = transcriptStatus(automation?.status, segments.isNotEmpty()),
    speakers = speakers.map { TranscriptSpeaker(it.speaker, it.ordinal, it.label, it.personId) },
    segments = segments.map { TranscriptSegment(it.index, it.speaker, it.label, it.text, it.startsAt, it.endsAt) },
    notes = meetingNotes?.toNotes(),
    event = event?.let { TranscriptEventRef(it.id, it.name) },
    context = context.toContext(),
    blobId = playback?.blobId,
)

private fun TranscriptNotesDto.toNotes(): TranscriptNotes = TranscriptNotes(
    summary = summary,
    decisions = decisions,
    actionItems = actionItems.map {
        TranscriptActionItem(it.id, it.text, it.ownerLabel, it.due, actionState(it.state), it.taskId, it.isMine)
    },
)

private fun TranscriptContextDto.toContext(): TranscriptContext = TranscriptContext(
    project = project?.toValue(),
    company = company?.toValue(),
    people = people.mapNotNull { it.toValue() },
)

private fun TranscriptContextValueDto.toValue(): TranscriptContextValue? {
    val key = id ?: personId ?: return null
    return TranscriptContextValue(key, name.orEmpty(), valueKind == "inherited")
}

private fun actionState(wire: String): TranscriptActionState = when (wire) {
    "added" -> TranscriptActionState.ADDED
    "noted" -> TranscriptActionState.NOTED
    "dismissed" -> TranscriptActionState.DISMISSED
    else -> TranscriptActionState.OPEN
}

/**
 * The detail has no status of its own: a transcript with its segments is done, one whose job failed is an error and
 * any other is still being processed.
 */
private fun transcriptStatus(automation: String?, hasSegments: Boolean) = when {
    hasSegments -> RecordingStatus.DONE
    automation == "error" -> RecordingStatus.ERROR
    else -> RecordingStatus.PROCESSING
}

internal fun TranscriptCandidateDto.toCandidate(): TranscriptCandidate =
    TranscriptCandidate(personId, name.orEmpty(), mappedSpeaker)
