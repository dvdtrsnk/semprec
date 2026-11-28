package cz.alldots.app.domain

import cz.alldots.app.core.FailureKind

/** Reads a period and refuses an answer that is about another period as invalid data. */
class LoadJournalPeriod(private val repository: JournalRepository) {
    suspend operator fun invoke(period: JournalPeriod): RepositoryResult<JournalPeriodPage> =
        when (val result = repository.period(period)) {
            is RepositoryResult.Failure -> result
            is RepositoryResult.Content ->
                if (result.value.period == period) result else RepositoryResult.Failure(FailureKind.INVALID_DATA)
        }
}
