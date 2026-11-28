package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.MailSignalField

enum class ProjectMailSignalsPhase { LOADING, READY, ERROR }

/** Where the preview of the matching threads is: being asked for, answered, or failed. */
enum class MailSignalsPreviewPhase { LOADING, READY, ERROR }

/** An address of one of the project's people, which counts as a signal and is edited on the person. */
data class MailSignalPersonItem(val personId: String, val name: String, val address: String)

/** One matching thread of the preview; [lastMessageAt] is the server's instant (ISO 8601). */
data class MailSignalThreadItem(
    val threadId: String,
    val subject: String,
    val senderName: String,
    val senderAddress: String,
    val lastMessageAt: String,
)

/**
 * The open threads (without a project) the signals on screen match: [total] of them, the newest as [threads], and
 * [alreadyAssigned] matching threads that already have a project. While [phase] is `LOADING` the previous answer stays.
 */
data class MailSignalsPreviewState(
    val phase: MailSignalsPreviewPhase = MailSignalsPreviewPhase.LOADING,
    val failure: FailureKind? = null,
    val total: Int = 0,
    val alreadyAssigned: Int = 0,
    val threads: List<MailSignalThreadItem> = emptyList(),
)

/** What the last assignment did: [assigned] threads got the project, [skipped] did not. */
data class MailSignalsAssignment(val assigned: Int, val skipped: Int)

/**
 * The mail signals of one project. The three lists are what is on screen; [unsaved] says they differ from what the
 * server keeps. Each list has the text being typed into it. [invalidField] is the list the last addition, save or
 * preview was refused for. [canSave] and [canAssign] say whether Save and "Assign N threads" act now; assigning
 * takes the threads of the saved signals, so it waits until the lists are saved.
 */
data class ProjectMailSignalsState(
    val phase: ProjectMailSignalsPhase = ProjectMailSignalsPhase.LOADING,
    val failure: FailureKind? = null,
    val people: List<MailSignalPersonItem> = emptyList(),
    val domains: List<String> = emptyList(),
    val addresses: List<String> = emptyList(),
    val keywords: List<String> = emptyList(),
    val domainInput: String = "",
    val addressInput: String = "",
    val keywordInput: String = "",
    val invalidField: MailSignalField? = null,
    val unsaved: Boolean = false,
    val saving: Boolean = false,
    val saveFailure: Failed? = null,
    val preview: MailSignalsPreviewState = MailSignalsPreviewState(),
    val assigning: Boolean = false,
    val assignFailure: Failed? = null,
    val assignment: MailSignalsAssignment? = null,
    val canSave: Boolean = false,
    val canAssign: Boolean = false,
)
