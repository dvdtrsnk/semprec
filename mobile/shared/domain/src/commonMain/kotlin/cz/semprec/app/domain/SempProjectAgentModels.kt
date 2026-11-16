package cz.semprec.app.domain

/** The four parts of a project's AGENT.md. */
data class SempGuidance(val purpose: String, val allowed: String, val notAllowed: String, val general: String)

/** The guidance with the version it was read at; [updatedAt] is `null` when the project has none yet. */
data class SempGuidanceDocument(val guidance: SempGuidance, val updatedAt: String?)

enum class SempDriftKind { PERMISSION, BEHAVIOR }

/** Something Semp does or is told that AGENT.md does not agree with. */
data class SempDriftFinding(
    val id: String,
    val kind: SempDriftKind,
    val claim: String,
    val blocking: Boolean,
    val suggestedAllowedLine: String?,
    val suggestedNotAllowedLine: String?,
)

data class SempDrift(val guidanceUpdatedAt: String?, val findings: List<SempDriftFinding>)

enum class SempDriftChoice { ALLOW, FORBID, DISMISS }

/** One tool the agent may be given in a project. */
data class SempToolGrant(
    val registrationId: String,
    val label: String,
    val toolName: String,
    val requiresApproval: Boolean,
    val granted: Boolean,
    val serverId: String,
    val serverName: String,
    val serverOnline: Boolean,
)

/** An automatic task of a project; [lastText] is the server's text of its last run, `null` when it never ran. */
data class SempProjectTask(
    val id: String,
    val name: String,
    val ruleLabel: String,
    val enabled: Boolean,
    val threadId: String?,
    val lastAt: String?,
    val lastFailed: Boolean,
    val lastWaiting: Boolean,
    val lastErrorSummary: String?,
)

/** Writing the guidance conflicted with a newer version; [current] is what the server holds now. */
sealed interface SempGuidanceSave {
    data class Saved(val document: SempGuidanceDocument) : SempGuidanceSave
    data class Conflict(val current: SempGuidanceDocument) : SempGuidanceSave
}

interface SempProjectAgentRepository {
    /** The name of the project, `null` when it has none. */
    suspend fun projectName(projectId: String): RepositoryResult<String?>

    suspend fun guidance(projectId: String): RepositoryResult<SempGuidanceDocument>

    /** Saves the whole guidance against the version [expectedUpdatedAt] it was read at. */
    suspend fun saveGuidance(
        projectId: String,
        guidance: SempGuidance,
        expectedUpdatedAt: String?,
    ): RepositoryResult<SempGuidanceSave>

    suspend fun drift(projectId: String): RepositoryResult<SempDrift>

    suspend fun resolveDrift(
        projectId: String,
        findingId: String,
        choice: SempDriftChoice,
        expectedGuidanceUpdatedAt: String?,
    ): RepositoryResult<SempGuidanceSave>

    suspend fun grants(projectId: String): RepositoryResult<List<SempToolGrant>>

    suspend fun setGrant(projectId: String, registrationId: String, granted: Boolean): RepositoryResult<Unit>

    suspend fun tasks(projectId: String): RepositoryResult<List<SempProjectTask>>

    suspend fun setTaskEnabled(taskId: String, enabled: Boolean): RepositoryResult<Unit>

    /** Runs the automatic task [taskId] now. */
    suspend fun runTask(taskId: String): RepositoryResult<Unit>
}
