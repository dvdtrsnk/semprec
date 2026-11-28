package cz.alldots.app.presentation

import cz.alldots.app.domain.Author
import cz.alldots.app.domain.CONTEXT_RELATIONS
import cz.alldots.app.domain.CollectionDatabase
import cz.alldots.app.domain.CollectionItem
import cz.alldots.app.domain.CollectionProperty
import cz.alldots.app.domain.FieldValue
import cz.alldots.app.domain.PropertyKind
import cz.alldots.app.domain.PropertyOption
import cz.alldots.app.domain.ValueKind
import cz.alldots.app.domain.ValueOrigin

internal fun CollectionProperty.fieldKind(): FieldKind? = when (kind) {
    PropertyKind.TEXT -> FieldKind.TEXT
    PropertyKind.LONG_TEXT -> FieldKind.LONG_TEXT
    PropertyKind.NUMBER -> FieldKind.NUMBER
    PropertyKind.SELECT -> FieldKind.SELECT
    PropertyKind.MULTI_SELECT -> FieldKind.MULTI_SELECT
    PropertyKind.DATE -> FieldKind.DATE
    PropertyKind.TIME -> FieldKind.TIME
    PropertyKind.CHECKBOX -> FieldKind.CHECKBOX
    PropertyKind.RELATION -> FieldKind.RELATION
    PropertyKind.FILE, PropertyKind.IMAGE -> FieldKind.FILE
    PropertyKind.URL -> FieldKind.URL
    PropertyKind.TITLE, PropertyKind.COLOR, PropertyKind.OTHER -> null
}

internal fun CollectionProperty.optionViews(): List<OptionView> = options.map { OptionView(it.key, it.label, it.color) }

/** The content of [value] for [property]; a property without a value is [FieldContent.Empty]. */
internal fun contentOf(property: CollectionProperty, value: FieldValue?): FieldContent = when (value) {
    null -> FieldContent.Empty
    is FieldValue.Text -> textContent(property.kind, value.text)
    is FieldValue.Number -> FieldContent.Number(value.number)
    is FieldValue.Flag -> FieldContent.Flag(value.on)
    is FieldValue.Choices -> {
        val options = value.keys.map { key -> property.options.firstOrNull { it.key == key } ?: optionOf(key) }
        if (options.isEmpty()) FieldContent.Empty else FieldContent.Choices(
            options.map {
                OptionView(it.key, it.label, it.color)
            }
        )
    }
    is FieldValue.Targets ->
        if (value.targets.isEmpty()) FieldContent.Empty
        else FieldContent.Targets(value.targets.map { TargetView(it.id, it.databaseKey, it.title, it.color) })
    is FieldValue.File ->
        FieldContent.Blob(value.blob.blobId, value.blob.filename, value.blob.mimeType, value.blob.byteSize)
}

private fun optionOf(key: String) = PropertyOption(key, key, null)

private fun textContent(kind: PropertyKind, text: String): FieldContent = when {
    text.isEmpty() -> FieldContent.Empty
    kind == PropertyKind.DATE -> FieldContent.Day(text)
    kind == PropertyKind.TIME -> FieldContent.Clock(text)
    kind == PropertyKind.URL -> FieldContent.Link(text)
    else -> FieldContent.Text(text)
}

internal fun ValueOrigin.toView(): OriginView? {
    val kind = when (kind) {
        ValueKind.OWN -> return null
        ValueKind.INHERITED -> OriginKind.INHERITED
        ValueKind.INHERITED_BROKEN -> OriginKind.INHERITED_BROKEN
        ValueKind.DERIVED -> OriginKind.DERIVED
    }
    val author = when (brokenBy) {
        Author.USER -> OriginAuthor.USER
        Author.AGENT -> OriginAuthor.AGENT
        null -> null
    }
    return OriginView(kind, sources.map { OriginSourceView(it.itemId, it.databaseKey, it.title) }, author)
}

/**
 * The properties of an item a detail screen shows, in the database's order: every property a person can read, with
 * the system-owned ones only once they hold a value, and relations only for the [contextRelations].
 */
internal fun CollectionItem.fieldViews(database: CollectionDatabase): List<FieldView> =
    database.properties.mapNotNull { property ->
        val kind = property.fieldKind() ?: return@mapNotNull null
        val content = contentOf(property, values[property.key])
        val origin = origins[property.key]?.toView()
        val hidden = (property.kind == PropertyKind.RELATION && property.key !in CONTEXT_RELATIONS) ||
            (property.system && content == FieldContent.Empty)
        if (hidden) return@mapNotNull null
        FieldView(
            propertyKey = property.key,
            name = property.name,
            kind = kind,
            content = content,
            options = property.optionViews(),
            editable = !property.system && origin?.kind != OriginKind.DERIVED && kind != FieldKind.FILE,
            origin = origin,
        )
    }
