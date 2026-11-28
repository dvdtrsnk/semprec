package cz.semprec.app.domain

/**
 * Removes a choice of a select or multi-select property, such as a tag of the projects, from the property and from
 * every item that holds it, and reads the schema again so that no later read offers it. When that read fails, the
 * choice is still removed and the answer is a success.
 */
class RemovePropertyOption(private val reads: CollectionReads, private val writes: PropertyWrites) {
    suspend operator fun invoke(property: CollectionProperty, key: String): RepositoryResult<Unit> {
        val removed = writes.removeOption(property, key)
        if (removed is RepositoryResult.Content) reads.refreshSchema()
        return removed
    }
}
