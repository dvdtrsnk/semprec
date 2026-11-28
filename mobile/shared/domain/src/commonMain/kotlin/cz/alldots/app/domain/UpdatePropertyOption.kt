package cz.alldots.app.domain

/**
 * Renames or recolors a choice of a select or multi-select property, such as a tag of the projects, and reads the
 * schema again so that every later read shows the choice as it is now. When that read fails, the change is still
 * made and the answer is the changed choice.
 */
class UpdatePropertyOption(private val reads: CollectionReads, private val writes: PropertyWrites) {
    suspend operator fun invoke(
        property: CollectionProperty,
        key: String,
        label: String?,
        color: String?,
    ): RepositoryResult<PropertyOption> {
        val updated = writes.updateOption(property, key, label, color)
        if (updated is RepositoryResult.Content) reads.refreshSchema()
        return updated
    }
}
