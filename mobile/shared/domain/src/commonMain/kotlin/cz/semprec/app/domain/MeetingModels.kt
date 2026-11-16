package cz.semprec.app.domain

import cz.semprec.app.core.MeetingTaskStatus

/** A task of an event; [detail] is the day it was finished on, or the name of the event it went to. */
data class MeetingTask(val id: String, val title: String, val status: MeetingTaskStatus, val detail: String?)

/** An action item of the event's transcripts the person may turn into a task. */
data class MeetingSuggestion(
    val transcriptId: String,
    val actionItemId: Int,
    val text: String,
    val ownerLabel: String?,
    val due: String?,
)

/** The tasks of an event, and the tasks its transcripts offer. */
interface MeetingRepository {
    suspend fun tasks(eventId: String): RepositoryResult<List<MeetingTask>>

    suspend fun suggestions(eventId: String): RepositoryResult<List<MeetingSuggestion>>

    /** Makes a task of [title] that the event hosts. */
    suspend fun addTask(eventId: String, title: String): RepositoryResult<Unit>

    suspend fun setDone(taskId: String, done: Boolean): RepositoryResult<Unit>
}
