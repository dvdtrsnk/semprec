package cz.semprec.app.domain

import cz.semprec.app.core.MailSignalField

/** A project's own mail signals, each list normalized as the server keeps it and without duplicates. */
data class MailSignalSet(
    val domains: List<String> = emptyList(),
    val addresses: List<String> = emptyList(),
    val keywords: List<String> = emptyList(),
) {
    fun values(field: MailSignalField): List<String> = when (field) {
        MailSignalField.DOMAINS -> domains
        MailSignalField.ADDRESSES -> addresses
        MailSignalField.KEYWORDS -> keywords
    }

    fun with(field: MailSignalField, values: List<String>): MailSignalSet = when (field) {
        MailSignalField.DOMAINS -> copy(domains = values)
        MailSignalField.ADDRESSES -> copy(addresses = values)
        MailSignalField.KEYWORDS -> copy(keywords = values)
    }
}

/** An address of one of the project's people. It counts as a signal and is edited on the person, not here. */
data class MailSignalPerson(val personId: String, val name: String, val address: String)

/** The signals of a project; [updatedAt] is `null` while the project has never had signals saved. */
data class ProjectMailSignals(
    val projectId: String,
    val signals: MailSignalSet,
    val updatedAt: String?,
    val people: List<MailSignalPerson>,
)

/**
 * The open threads (no project yet) that signals match: [total] of them, the newest of them as [threads] (at most 50,
 * newest first), and [alreadyAssigned] matching threads that already have a project.
 */
data class MailSignalPreview(val total: Int, val alreadyAssigned: Int, val threads: List<MailThreadSummary>)

/** What an assignment did: [assigned] threads got the project, [skipped] no longer matched or were no longer open. */
data class MailSignalAssignment(val assigned: Int, val skipped: Int)

/** How a call that sends signals ended: [Done] with its answer, or [Invalid] when the server refused one list. */
sealed interface MailSignalsOutcome<out T> {
    data class Done<out T>(val value: T) : MailSignalsOutcome<T>

    data class Invalid(val field: MailSignalField) : MailSignalsOutcome<Nothing>
}

/**
 * The mail signals of one project. The people of the project count as signals on every call without being sent.
 * An unknown or trashed project is [cz.semprec.app.core.FailureKind.NOT_FOUND].
 */
interface ProjectMailSignalsRepository {
    suspend fun signals(projectId: String): RepositoryResult<ProjectMailSignals>

    /** Replaces the project's own signals and answers them as the server normalized them. */
    suspend fun save(
        projectId: String,
        signals: MailSignalSet,
    ): RepositoryResult<MailSignalsOutcome<ProjectMailSignals>>

    /** The open threads [draft] matches, or the saved signals when [draft] is `null`; writes nothing. */
    suspend fun preview(
        projectId: String,
        draft: MailSignalSet?,
    ): RepositoryResult<MailSignalsOutcome<MailSignalPreview>>

    /**
     * Gives the project to each of [threadIds] (1 to [MAX_MAIL_SIGNAL_APPLY_THREADS]) that the saved signals still
     * match and that is still open; the others are skipped.
     */
    suspend fun apply(projectId: String, threadIds: List<String>): RepositoryResult<MailSignalAssignment>
}

/** The threads one assignment may name. */
const val MAX_MAIL_SIGNAL_APPLY_THREADS = 200
