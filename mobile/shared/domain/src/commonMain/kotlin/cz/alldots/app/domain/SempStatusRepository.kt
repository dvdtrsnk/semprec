package cz.alldots.app.domain

/** The health of Semp and the services it depends on. */
interface SempStatusRepository {
    suspend fun report(): RepositoryResult<SempStatusReport>

    suspend fun summary(): RepositoryResult<SempStatusSummary>
}
