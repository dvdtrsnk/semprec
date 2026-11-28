package cz.alldots.app.domain

enum class SempProblemSeverity { CRITICAL, WARNING }

/** What a problem can be fixed or followed with. Kinds the app cannot carry out are left out of the report. */
sealed interface SempProblemAction {
    data class RetryRun(val runId: String) : SempProblemAction
    data class RetryPrompt(val threadId: String, val messageId: String) : SempProblemAction
    data class OpenChat(val threadId: String, val messageId: String) : SempProblemAction
    data class OpenThread(val threadId: String) : SempProblemAction
    data class DisableHeartbeat(val heartbeatId: String) : SempProblemAction
    data class OpenProject(val projectId: String) : SempProblemAction
    data class OpenMailbox(val mailboxId: String) : SempProblemAction
}

/** One active problem; [title], [text] and [shortText] are the server's, in the person's language. */
data class SempProblem(
    val id: String,
    val category: String,
    val severity: SempProblemSeverity,
    val title: String,
    val text: String,
    val shortText: String,
    val since: String?,
    val mergedCount: Int,
    val projectName: String?,
    val actions: List<SempProblemAction>,
)

/** One service of the report; [name] is the server's text, [failingSince] is set while the service has a problem. */
data class SempService(val key: String, val name: String, val failingSince: String?, val lastActivityAt: String?)

data class SempResolvedProblem(val id: String, val title: String, val resolvedAt: String)

data class SempStatusReport(
    val activeCount: Int,
    val services: List<SempService>,
    val problems: List<SempProblem>,
    val resolved: List<SempResolvedProblem>,
)

/** The count of active problems and the problem a notice would show, for the chat and the profile. */
data class SempStatusSummary(
    val activeCount: Int,
    val bannerProblemId: String?,
    val bannerTitle: String?,
    val bannerText: String?,
)
