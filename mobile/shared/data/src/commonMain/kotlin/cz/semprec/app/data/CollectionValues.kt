package cz.semprec.app.data

import cz.semprec.app.domain.FieldValue
import cz.semprec.app.domain.PropertyKind
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * Narrows the stored JSON value of a property to the shape its [kind] has. A value of another shape, an empty one and
 * a kind that is stored elsewhere (relations, files) give `null`: the property shows as empty rather than failing.
 */
internal fun decodeValue(kind: PropertyKind, element: JsonElement): FieldValue? = when (kind) {
    PropertyKind.TITLE, PropertyKind.TEXT, PropertyKind.LONG_TEXT, PropertyKind.URL, PropertyKind.COLOR,
    PropertyKind.DATE, PropertyKind.TIME,
    -> text(element)?.let { FieldValue.Text(it) }
    PropertyKind.NUMBER -> (element as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.let { FieldValue.Number(it) }
    PropertyKind.CHECKBOX -> (element as? JsonPrimitive)?.booleanOrNull?.let { FieldValue.Flag(it) }
    PropertyKind.SELECT -> text(element)?.let { FieldValue.Choices(listOf(it)) }
    PropertyKind.MULTI_SELECT -> (element as? JsonArray)?.mapNotNull(::text)?.let { FieldValue.Choices(it) }
    PropertyKind.RELATION, PropertyKind.FILE, PropertyKind.IMAGE, PropertyKind.OTHER -> null
}

private fun text(element: JsonElement): String? =
    (element as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

/** The JSON a write sends for [value] of a property of [kind]; `null` clears the property. */
internal fun encodeValue(kind: PropertyKind, value: FieldValue?): JsonElement = when (value) {
    null -> JsonNull
    is FieldValue.Text -> JsonPrimitive(value.text)
    is FieldValue.Number -> JsonPrimitive(value.number)
    is FieldValue.Flag -> JsonPrimitive(value.on)
    is FieldValue.Choices ->
        if (kind == PropertyKind.MULTI_SELECT) JsonArray(value.keys.map(::JsonPrimitive))
        else value.keys.firstOrNull()?.let(::JsonPrimitive) ?: JsonNull
    is FieldValue.Targets, is FieldValue.File -> JsonNull
}
