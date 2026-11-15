package cz.semprec.app.data

import cz.semprec.app.domain.Author
import cz.semprec.app.domain.BlobRef
import cz.semprec.app.domain.CollectionDatabase
import cz.semprec.app.domain.CollectionItem
import cz.semprec.app.domain.CollectionPage
import cz.semprec.app.domain.DeleteImpact
import cz.semprec.app.domain.FieldValue
import cz.semprec.app.domain.FilterTree
import cz.semprec.app.domain.ImpactCollection
import cz.semprec.app.domain.OriginSource
import cz.semprec.app.domain.PropertyKind
import cz.semprec.app.domain.RelatedCollection
import cz.semprec.app.domain.RelationTarget
import cz.semprec.app.domain.ValueKind
import cz.semprec.app.domain.ValueOrigin
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/** One item as the item routes answer it; the values are decoded by the properties of its database. */
@Serializable
internal data class ItemDto(
    val id: String,
    val databaseId: String,
    val properties: Map<String, JsonElement> = emptyMap(),
    val relations: Map<String, List<RelationTargetDto>> = emptyMap(),
    val links: Map<String, LinkDto> = emptyMap(),
    val derived: DerivedDto? = null,
    val blobs: Map<String, BlobDto> = emptyMap(),
    val createdAt: String = "",
    val updatedAt: String = "",
) {
    fun toDomain(database: CollectionDatabase): CollectionItem {
        val values = LinkedHashMap<String, FieldValue>()
        for (property in database.properties) {
            val value = when (property.kind) {
                PropertyKind.RELATION -> relations[property.key]?.let(::targetsOf)
                PropertyKind.FILE, PropertyKind.IMAGE -> blobs[property.key]?.let { FieldValue.File(it.toDomain()) }
                else -> properties[property.key]?.let { decodeValue(property.kind, it) }
            }
            if (value != null) values[property.key] = value
        }
        derived?.apply(values, database)
        return CollectionItem(id, databaseId, values, originsOf(), createdAt, updatedAt)
    }

    private fun targetsOf(targets: List<RelationTargetDto>): FieldValue =
        FieldValue.Targets(targets.filter { !it.hidden }.map { it.toDomain() })

    private fun originsOf(): Map<String, ValueOrigin> {
        val origins = LinkedHashMap<String, ValueOrigin>()
        links.forEach { (key, link) -> origins[key] = link.toDomain() }
        derived?.keysWithSources()?.forEach { (key, sources) ->
            if (key !in origins) origins[key] = ValueOrigin(ValueKind.DERIVED, sources, null)
        }
        return origins
    }
}

@Serializable
internal data class RelationTargetDto(
    val id: String,
    val databaseKey: String? = null,
    val title: String = "",
    val color: String? = null,
    val hidden: Boolean = false,
) {
    fun toDomain(): RelationTarget = RelationTarget(id, databaseKey, title, color)
}

@Serializable
internal data class BlobDto(
    val blobId: String,
    val byteSize: Long = 0,
    val mimeType: String = "",
    val filename: String? = null,
) {
    fun toDomain(): BlobRef = BlobRef(blobId, byteSize, mimeType, filename)
}

@Serializable
internal data class LinkDto(
    val valueKind: String,
    val sources: List<LinkSourceDto> = emptyList(),
    val brokenBy: String? = null,
) {
    fun toDomain(): ValueOrigin = ValueOrigin(
        kind = when (valueKind) {
            "inherited" -> ValueKind.INHERITED
            "inheritedBroken" -> ValueKind.INHERITED_BROKEN
            else -> ValueKind.DERIVED
        },
        sources = sources.map { it.toDomain() },
        brokenBy = when (brokenBy) {
            "user" -> Author.USER
            "agent" -> Author.AGENT
            else -> null
        },
    )
}

/** Where a value is taken from: an item, or (for a mail thread) the sender's domain. */
@Serializable
internal data class LinkSourceDto(
    val kind: String = "item",
    val itemId: String? = null,
    val databaseKey: String? = null,
    val title: String? = null,
    val domain: String? = null,
    val propertyKey: String? = null,
) {
    fun toDomain(): OriginSource = OriginSource(itemId, databaseKey, title ?: domain.orEmpty(), propertyKey)
}

/** The values the server computes from an item's projects: its area and its company. */
@Serializable
internal data class DerivedDto(val area: DerivedValuesDto? = null, val company: DerivedValuesDto? = null) {
    fun apply(values: MutableMap<String, FieldValue>, database: CollectionDatabase) {
        area?.let { if (database.property(AREA)?.kind == PropertyKind.RELATION) values[AREA] = it.toTargets("areas") }
        company?.let {
            if (database.property(COMPANY)?.kind == PropertyKind.RELATION) values[COMPANY] = it.toTargets("companies")
        }
    }

    fun keysWithSources(): List<Pair<String, List<OriginSource>>> = listOfNotNull(
        area?.let { AREA to it.sources() },
        company?.let { COMPANY to it.sources() },
    )

    private companion object {
        const val AREA = "area"
        const val COMPANY = "company"
    }
}

@Serializable
internal data class DerivedValuesDto(
    val values: List<DerivedValueDto> = emptyList(),
    val projectIds: List<String> = emptyList()
) {
    fun toTargets(databaseKey: String): FieldValue =
        FieldValue.Targets(values.map { RelationTarget(it.id, databaseKey, it.title, it.color) })

    fun sources(): List<OriginSource> = projectIds.map { OriginSource(it, "projects", "", null) }
}

@Serializable
internal data class DerivedValueDto(val id: String, val title: String = "", val color: String? = null)

/** `POST /api/databases/:id/query`: a page of items and the cursor of the next page. */
@Serializable
internal data class ItemPageDto(val items: List<ItemDto> = emptyList(), val nextCursor: String? = null) {
    fun toDomain(database: CollectionDatabase): CollectionPage =
        CollectionPage(items.map { it.toDomain(database) }, nextCursor)
}

@Serializable
internal data class RelatedDto(
    val databaseKey: String? = null,
    val databaseId: String,
    val count: Int = 0,
    val filter: JsonElement? = null,
) {
    fun toDomain(): RelatedCollection = RelatedCollection(
        databaseKey,
        databaseId,
        count,
        filter?.let { FilterTree(ApiJson.encodeToString(JsonElement.serializer(), it)) },
    )
}

/** `GET /api/items/:id/delete-impact`. */
@Serializable
internal data class DeleteImpactDto(
    val related: List<ImpactCollectionDto> = emptyList(),
    val subtreeItemCount: Int = 0,
    val subtreePageCount: Int = 0,
    val linksToOwn: List<JsonElement> = emptyList(),
    val seriesInstanceCount: Int = 0,
    val attachmentCount: Int = 0,
    val hostEventCount: Int = 0,
) {
    fun toDomain(): DeleteImpact = DeleteImpact(
        related = related.map { ImpactCollection(it.databaseKey, it.count) },
        nestedItems = subtreeItemCount,
        nestedPages = subtreePageCount,
        takenOverValues = linksToOwn.size,
        seriesInstances = seriesInstanceCount,
        attachments = attachmentCount,
        hostEvents = hostEventCount,
    )
}

@Serializable
internal data class ImpactCollectionDto(val databaseKey: String? = null, val count: Int = 0)
