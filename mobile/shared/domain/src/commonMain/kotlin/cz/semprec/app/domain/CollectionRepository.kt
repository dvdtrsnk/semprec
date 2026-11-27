package cz.semprec.app.domain

/**
 * The reading half of the generic item API of the server: the schema, queries over any database, one item with its
 * values, links and relations, its page and its blobs. Every method answers an expected failure as a value.
 */
interface CollectionReads {
    /** The databases and their properties; the answer is kept until [refreshSchema] asks for it again. */
    suspend fun schema(): RepositoryResult<CollectionSchema>

    suspend fun refreshSchema(): RepositoryResult<CollectionSchema>

    suspend fun query(database: CollectionDatabase, query: CollectionQuery): RepositoryResult<CollectionPage>

    /** The choices of each property in [propertyKeys] under [query]'s filter, each facet ignoring its own selection. */
    suspend fun facets(
        database: CollectionDatabase,
        query: CollectionQuery,
        propertyKeys: List<String>,
    ): RepositoryResult<List<FacetResult>>

    /**
     * One item with its relations, value links and derived values. [expand] names the relation properties whose
     * targets come back (at most five).
     */
    suspend fun item(itemId: String, expand: List<String>): RepositoryResult<CollectionItem>

    /** The collections connected to the item, in the order the item's database declares. */
    suspend fun related(itemId: String): RepositoryResult<List<RelatedCollection>>

    /** What deleting the item would reach; it changes nothing. */
    suspend fun deleteImpact(itemId: String): RepositoryResult<DeleteImpact>

    suspend fun page(itemId: String): RepositoryResult<PageContent>

    suspend fun blob(blobId: String): RepositoryResult<BlobContent>
}

/**
 * The writing half of the generic item API, with the choices of a property that the items' values pick from; each
 * method answers an expected failure as a value.
 */
interface CollectionWrites : PropertyWrites {
    /** Creates an item with its title and, optionally, one relation (a file of a project). */
    suspend fun create(
        database: CollectionDatabase,
        title: String,
        relation: Pair<String, String>?,
    ): RepositoryResult<CollectionItem>

    /** Writes the given values; a `null` value clears the property. [version] is the item's `version`. */
    suspend fun update(
        database: CollectionDatabase,
        itemId: String,
        version: String,
        changes: Map<String, FieldValue?>,
    ): RepositoryResult<CollectionItem>

    /**
     * Makes [targetId] the one target of a single-valued relation, or clears it with `null`. A relation that holds
     * several targets refuses it as `REJECTED`; [link] adds to those.
     */
    suspend fun setRelation(itemId: String, propertyKey: String, targetId: String?): RepositoryResult<Unit>

    /** Adds an edge from the item to [targetId] on the relation; an edge that exists is left as it is. */
    suspend fun link(itemId: String, propertyKey: String, targetId: String): RepositoryResult<Unit>

    suspend fun unlinkEdge(itemId: String, propertyKey: String, targetId: String): RepositoryResult<Unit>

    /** Ends the link that makes the property follow its source; the value stays as the item's own. */
    suspend fun unlinkValue(itemId: String, propertyKey: String): RepositoryResult<Unit>

    /** Makes the property follow its source again. */
    suspend fun relinkValue(itemId: String, propertyKey: String): RepositoryResult<Unit>

    suspend fun delete(itemId: String): RepositoryResult<Unit>

    /** Replaces the item's page when [etag] is still the page's current version. */
    suspend fun replacePage(itemId: String, markdown: String, etag: String): RepositoryResult<PageContent>

    /** Uploads a file into the Files collection, optionally attached to an item through one of its relations. */
    suspend fun upload(
        filename: String,
        mimeType: String,
        bytes: ByteArray,
        attachTo: Pair<String, String>?,
    ): RepositoryResult<CollectionItem>
}

/** The writes of a property's own choices; each method answers an expected failure as a value. */
interface PropertyWrites {
    /** Adds a choice with [label] to a select or multi-select [property]; the server makes its key. */
    suspend fun addOption(property: CollectionProperty, label: String): RepositoryResult<PropertyOption>
}
