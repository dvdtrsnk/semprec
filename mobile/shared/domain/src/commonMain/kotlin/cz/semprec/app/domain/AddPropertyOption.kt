package cz.semprec.app.domain

/**
 * Adds a choice to a select or multi-select property, such as a new tag of a project, and reads the schema again so
 * that every later read knows the new choice by its label. When that read fails, the choice is still added and the
 * answer is the added choice: until the schema is read again, an item holding it shows its key in place of its label.
 */
class AddPropertyOption(private val reads: CollectionReads, private val writes: PropertyWrites) {
    suspend operator fun invoke(property: CollectionProperty, label: String): RepositoryResult<PropertyOption> {
        val added = writes.addOption(property, label)
        if (added is RepositoryResult.Content) reads.refreshSchema()
        return added
    }
}
