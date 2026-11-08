package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind

/** Rejects blank or duplicate ids as invalid data and orders the items by ordinal, then by id. */
class LoadPlaceholderItems(private val repository: PlaceholderRepository) {
    suspend operator fun invoke(): RepositoryResult<List<PlaceholderItem>> = when (val result = repository.items()) {
        is RepositoryResult.Failure -> result
        is RepositoryResult.Content -> if (result.value.hasInvalidIdentity()) {
            RepositoryResult.Failure(FailureKind.INVALID_DATA)
        } else {
            RepositoryResult.Content(result.value.sortedWith(compareBy({ it.ordinal }, { it.id })))
        }
    }
}

private fun List<PlaceholderItem>.hasInvalidIdentity(): Boolean =
    any { it.id.isBlank() } || map { it.id }.distinct().size != size
