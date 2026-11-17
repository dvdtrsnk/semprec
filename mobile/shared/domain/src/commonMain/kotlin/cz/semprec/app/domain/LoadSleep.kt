package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind

/** Reads the sleep data and refuses plans without an identity or with a repeated one as invalid data. */
class LoadSleep(private val repository: SleepRepository) {
    suspend operator fun invoke(night: CalendarDay?): RepositoryResult<SleepOverview> =
        when (val result = repository.overview(night)) {
            is RepositoryResult.Failure -> result
            is RepositoryResult.Content -> {
                val plans = result.value.plans
                if (plans.any { it.id.isBlank() } || plans.map { it.id }.distinct().size != plans.size) {
                    RepositoryResult.Failure(FailureKind.INVALID_DATA)
                } else {
                    RepositoryResult.Content(result.value.copy(plans = SleepRules.ordered(plans)))
                }
            }
        }
}
