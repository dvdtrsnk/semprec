package cz.semprec.app.presentation

import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.CancellationException

/**
 * Runs a call of the domain: an expected failure stays the value it is, cancellation is rethrown, and any other
 * exception becomes `null`, which the caller shows as an unexpected failure without a reason.
 */
internal suspend fun <T> guarded(call: suspend () -> RepositoryResult<T>): RepositoryResult<T>? = try {
    call()
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (_: Exception) {
    null
}
