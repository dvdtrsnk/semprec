package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.RepositoryResult
import kotlinx.coroutines.CancellationException

/**
 * What a use case or repository call came to, as a screen sees it: a value, or a failure. [Rejected.kind] is `null`
 * for an unexpected exception, which has no typed reason; cancellation is never an answer and is always rethrown.
 */
internal sealed interface Answer<out T> {
    data class Done<out T>(val value: T) : Answer<T>
    data class Rejected(val kind: FailureKind?) : Answer<Nothing>
}

internal suspend fun <T> answer(call: suspend () -> RepositoryResult<T>): Answer<T> = try {
    when (val result = call()) {
        is RepositoryResult.Content -> Answer.Done(result.value)
        is RepositoryResult.Failure -> Answer.Rejected(result.kind)
    }
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (_: Exception) {
    Answer.Rejected(null)
}
