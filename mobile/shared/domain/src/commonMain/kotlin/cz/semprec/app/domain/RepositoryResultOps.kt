package cz.semprec.app.domain

/** The content changed by [transform]; a failure stays the failure it is. */
inline fun <T, R> RepositoryResult<T>.map(transform: (T) -> R): RepositoryResult<R> = when (this) {
    is RepositoryResult.Content -> RepositoryResult.Content(transform(value))
    is RepositoryResult.Failure -> this
}

/** The next step that needs this content; a failure stops the chain and stays the failure it is. */
inline fun <T, R> RepositoryResult<T>.then(next: (T) -> RepositoryResult<R>): RepositoryResult<R> = when (this) {
    is RepositoryResult.Content -> next(value)
    is RepositoryResult.Failure -> this
}
