package cz.semprec.app.data

import cz.semprec.app.domain.ItemRepository
import cz.semprec.app.domain.MeetingRepository
import cz.semprec.app.domain.RecordingsRepository
import cz.semprec.app.domain.TranscriptRepository

/**
 * The recording, transcript and meeting repositories of one signed-in session. [details] reads and finishes the
 * tasks of an event with the same item repository the Podrobnosti sheet uses.
 */
class RecordingsData(api: AuthenticatedApi, details: ItemRepository) {
    val recordings: RecordingsRepository = HttpRecordingsRepository(api)
    val transcripts: TranscriptRepository = HttpTranscriptRepository(api)
    val meetings: MeetingRepository = HttpMeetingRepository(api, ItemsApi(api), ItemWrites(api), details)
}
