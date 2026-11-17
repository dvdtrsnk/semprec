package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind

/** Loads one item. An unknown id is content without an item; an item with a different id is invalid data. */
class LoadPlaceholderItem(private val repository: PlaceholderRepository) {
    suspend operator fun invoke(id: String): RepositoryResult<PlaceholderItem?> =
        when (val result = repository.item(id)) {
            is RepositoryResult.Failure -> result
            is RepositoryResult.Content -> if (result.value == null || result.value.id == id) {
                result
            } else {
                RepositoryResult.Failure(FailureKind.INVALID_DATA)
            }
        }
}
