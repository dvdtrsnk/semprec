package cz.semprec.app.data

import cz.semprec.app.core.RecordingPairing
import cz.semprec.app.core.RecordingStatus
import cz.semprec.app.domain.RecordingEntry
import kotlinx.serialization.Serializable

/** `GET /api/transcripts`: one page of the recordings, newest first. */
@Serializable
internal data class RecordingPageDto(val transcripts: List<RecordingRowDto> = emptyList())

@Serializable
internal data class RecordingRowDto(
    val id: String,
    val displayName: String = "",
    val date: String? = null,
    val durationSeconds: Double? = null,
    val status: String? = null,
    val pairing: String = "none",
    val event: RecordingEventDto? = null,
    val shortSummary: String? = null,
)

@Serializable
internal data class RecordingEventDto(val id: String, val name: String? = null)

/** An unknown status is no status and an unknown pairing is none, so a server that adds one does not break a list. */
internal fun RecordingRowDto.toEntry(): RecordingEntry = RecordingEntry(
    id = id,
    name = displayName,
    date = date,
    durationSeconds = durationSeconds?.toInt(),
    status = status?.let { recordingStatus(it) },
    pairing = recordingPairing(pairing),
    eventId = event?.id,
    eventName = event?.name,
    shortSummary = shortSummary?.takeIf { it.isNotBlank() },
)

internal fun recordingStatus(wire: String): RecordingStatus? = when (wire) {
    "recording" -> RecordingStatus.RECORDING
    "processing" -> RecordingStatus.PROCESSING
    "done" -> RecordingStatus.DONE
    "error" -> RecordingStatus.ERROR
    else -> null
}

private fun recordingPairing(wire: String): RecordingPairing = when (wire) {
    "processing" -> RecordingPairing.PROCESSING
    "event" -> RecordingPairing.EVENT
    "awaitingEvent" -> RecordingPairing.AWAITING_EVENT
    else -> RecordingPairing.NONE
}
