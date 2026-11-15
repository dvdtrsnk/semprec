package cz.semprec.app.presentation

import cz.semprec.app.domain.CollectionDatabase
import cz.semprec.app.domain.FieldValue

/** The title write for a new name; a blank name changes nothing. */
internal fun titleChange(database: CollectionDatabase?, title: String): Map<String, FieldValue?> {
    val key = database?.title?.key
    val name = title.trim()
    return if (key == null || name.isEmpty()) emptyMap() else mapOf(key to FieldValue.Text(name))
}

internal fun textValue(text: String): FieldValue? = text.trim().ifEmpty { null }?.let { FieldValue.Text(it) }

internal fun choiceValue(keys: List<String>): FieldValue? = keys.ifEmpty { null }?.let { FieldValue.Choices(it) }
