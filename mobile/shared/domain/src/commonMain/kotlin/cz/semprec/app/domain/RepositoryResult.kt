package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind

/** Outcome of a repository port or use case: content, or an expected failure as a value. */
sealed interface RepositoryResult<out T> {
    data class Content<out T>(val value: T) : RepositoryResult<T>
    data class Failure(val kind: FailureKind) : RepositoryResult<Nothing>
}
