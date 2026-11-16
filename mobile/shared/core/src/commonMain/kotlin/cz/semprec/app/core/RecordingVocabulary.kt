package cz.semprec.app.core

/** Where a recording is on its way to a transcript. `null` where it is used means the server did not say. */
enum class RecordingStatus { RECORDING, PROCESSING, DONE, ERROR }

/**
 * How a recording relates to an event: [PROCESSING] it is still being processed, [EVENT] it belongs to one,
 * [AWAITING_EVENT] Semp asked in the Inbox which one it belongs to, [NONE] it belongs to none.
 */
enum class RecordingPairing { PROCESSING, EVENT, AWAITING_EVENT, NONE }

/** What became of one action item of a transcript: [ADDED] a task was made of it, [NOTED] the person follows it. */
enum class TranscriptActionState { OPEN, ADDED, NOTED, DISMISSED }

/**
 * How a task of an event stands in it: [DONE_ELSEWHERE] it was finished in another event or on a day, [MOVED] it
 * lives in a later event now, [MISSED] it is still open although the event is over.
 */
enum class MeetingTaskStatus { OPEN, MISSED, DONE, DONE_ELSEWHERE, MOVED }
