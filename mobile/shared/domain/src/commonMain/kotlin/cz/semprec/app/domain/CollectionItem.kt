package cz.semprec.app.domain

/** An item another item points at. [databaseKey] is `null` for a database a person created. */
data class RelationTarget(val id: String, val databaseKey: String?, val title: String, val color: String?)

/** The bytes a `file` or `image` value points at, described by the server without downloading them. */
data class BlobRef(val blobId: String, val byteSize: Long, val mimeType: String, val filename: String?)

/** The value of one property, in the shape its [PropertyKind] has. */
sealed interface FieldValue {
    data class Text(val text: String) : FieldValue
    data class Number(val number: Double) : FieldValue
    data class Flag(val on: Boolean) : FieldValue

    /** The keys of the chosen options: one for a select, any number for a multi-select. */
    data class Choices(val keys: List<String>) : FieldValue
    data class Targets(val targets: List<RelationTarget>) : FieldValue
    data class File(val blob: BlobRef) : FieldValue
}

/**
 * Where a value comes from: [OWN] is set by a person or Semp, [INHERITED] follows another item until the first
 * change, [INHERITED_BROKEN] was inherited and no longer follows its source, [DERIVED] is always computed from
 * another item and cannot be overwritten.
 */
enum class ValueKind { OWN, INHERITED, INHERITED_BROKEN, DERIVED }

enum class Author { USER, AGENT }

/** The item, or the mail sender domain, a value is taken from. */
data class OriginSource(val itemId: String?, val databaseKey: String?, val title: String, val propertyKey: String?)

data class ValueOrigin(val kind: ValueKind, val sources: List<OriginSource>, val brokenBy: Author?)

/**
 * One item with every value decoded by the type of its property. [origins] holds an entry only for a property whose
 * value is not [ValueKind.OWN]. [version] is the token a later write passes back (`updatedAt`).
 */
data class CollectionItem(
    val id: String,
    val databaseId: String,
    val values: Map<String, FieldValue>,
    val origins: Map<String, ValueOrigin>,
    val createdAt: String,
    val version: String,
)

/** One collection connected to an item, with the filter that selects exactly the connected items. */
data class RelatedCollection(
    val databaseKey: String?,
    val databaseId: String,
    val count: Int,
    val filter: FilterTree?,
)

/** A page of the item's own document as Markdown with the token a replace passes back. */
data class PageContent(val markdown: String, val etag: String)

/** Bytes of a blob. */
class BlobContent(val mimeType: String, val bytes: ByteArray)

/** How many items of one collection a deletion reaches. [databaseKey] is `null` for a database a person created. */
data class ImpactCollection(val databaseKey: String?, val count: Int)

/**
 * What deleting an item reaches: the connected items per collection, the items and pages below it, the values other
 * items take over from it, and what a recurring task, an event or a task attachment adds.
 */
data class DeleteImpact(
    val related: List<ImpactCollection>,
    val nestedItems: Int,
    val nestedPages: Int,
    val takenOverValues: Int,
    val seriesInstances: Int,
    val attachments: Int,
    val hostEvents: Int,
)
