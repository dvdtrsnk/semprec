package cz.alldots.app.domain

import cz.alldots.app.core.FailureKind

/** The report of Semp's health. */
class LoadSempStatus(private val repository: SempStatusRepository) {
    suspend operator fun invoke(): RepositoryResult<SempStatusReport> = repository.report()
}

class LoadSempStatusSummary(private val repository: SempStatusRepository) {
    suspend operator fun invoke(): RepositoryResult<SempStatusSummary> = repository.summary()
}

/** Reads a run. A blank id is invalid data. */
class LoadSempRun(private val repository: SempRunRepository) {
    suspend operator fun invoke(runId: String, messageId: String?): RepositoryResult<SempRun> =
        if (runId.isBlank()) RepositoryResult.Failure(FailureKind.INVALID_DATA) else repository.run(runId, messageId)
}

/** Reads every step of a run, page after page, up to [MAX_PAGES] pages. */
class LoadSempRunSteps(private val repository: SempRunRepository) {
    suspend operator fun invoke(runId: String, messageId: String?): RepositoryResult<SempRunStepsPage> {
        val steps = mutableListOf<SempRunStep>()
        var after: String? = null
        var truncated = false
        var failure: RepositoryResult.Failure? = null
        var pages = 0
        do {
            when (val page = repository.steps(runId, messageId, after)) {
                is RepositoryResult.Failure -> {
                    failure = page
                    after = null
                }
                is RepositoryResult.Content -> {
                    steps += page.value.steps
                    truncated = truncated || page.value.truncatedHistory
                    after = page.value.nextCursor
                }
            }
            pages++
        } while (failure == null && after != null && pages < MAX_PAGES)
        return failure ?: RepositoryResult.Content(SempRunStepsPage(steps, after, truncated))
    }

    private companion object {
        const val MAX_PAGES = 10
    }
}

class RetrySempRun(private val repository: SempRunRepository) {
    suspend operator fun invoke(runId: String): RepositoryResult<Unit> = repository.retry(runId)
}

class ListSempProjectRuns(private val repository: SempRunRepository) {
    suspend operator fun invoke(projectId: String): RepositoryResult<List<SempProjectRun>> =
        repository.projectRuns(projectId)
}

/** The queue of approval requests, and what a decision on one of them turns it into. */
class ListSempApprovals(private val repository: SempApprovalRepository) {
    suspend operator fun invoke(pending: Boolean, cursor: String?): RepositoryResult<SempApprovalsPage> =
        repository.list(pending, cursor)
}

class GetSempApproval(private val repository: SempApprovalRepository) {
    suspend operator fun invoke(approvalId: String): RepositoryResult<SempApproval> = repository.get(approvalId)
}

class CountSempApprovals(private val repository: SempApprovalRepository) {
    suspend operator fun invoke(): RepositoryResult<Int> = repository.pendingCount()
}

class DecideSempApproval(private val repository: SempApprovalRepository) {
    suspend operator fun invoke(approvalId: String, approve: Boolean): RepositoryResult<SempApproval> =
        repository.decide(approvalId, approve)
}

/** What a project's agent page reads and writes. */
class LoadSempProjectAgent(private val repository: SempProjectAgentRepository) {
    suspend fun projectName(projectId: String) = repository.projectName(projectId)

    suspend fun guidance(projectId: String) = repository.guidance(projectId)

    suspend fun drift(projectId: String) = repository.drift(projectId)

    suspend fun grants(projectId: String) = repository.grants(projectId)

    suspend fun tasks(projectId: String) = repository.tasks(projectId)
}

class EditSempProjectAgent(private val repository: SempProjectAgentRepository) {
    suspend fun saveGuidance(projectId: String, guidance: SempGuidance, expectedUpdatedAt: String?) =
        repository.saveGuidance(projectId, guidance, expectedUpdatedAt)

    suspend fun resolveDrift(
        projectId: String,
        finding: SempDriftFinding,
        choice: SempDriftChoice,
        expectedGuidanceUpdatedAt: String?,
    ): RepositoryResult<SempGuidanceSave> {
        val applicable = choice == SempDriftChoice.DISMISS || finding.kind == SempDriftKind.BEHAVIOR
        return if (applicable) {
            repository.resolveDrift(projectId, finding.id, choice, expectedGuidanceUpdatedAt)
        } else {
            RepositoryResult.Failure(FailureKind.REJECTED)
        }
    }

    suspend fun setGrant(projectId: String, registrationId: String, granted: Boolean) =
        repository.setGrant(projectId, registrationId, granted)

    suspend fun setTaskEnabled(taskId: String, enabled: Boolean) = repository.setTaskEnabled(taskId, enabled)

    suspend fun runTask(taskId: String) = repository.runTask(taskId)
}
