package cz.semprec.app.domain.note

import cz.semprec.app.domain.InlineRun
import cz.semprec.app.domain.PageBlockType

/** Ids `n1`, `n2`… in the order they are asked for. */
class TestIds {
    private var next = 0
    val newId: () -> String = { "n${++next}" }
}

fun block(
    id: String,
    text: String = "",
    type: PageBlockType = PageBlockType.TEXT,
    indent: Int = 0,
    done: Boolean = false,
    pageId: String? = null,
) = NoteBlock(id, type, indent, done, if (text.isEmpty()) emptyList() else listOf(InlineRun(text)), pageId)

/** `id:type:indent:text` of each block, for comparing a whole note in one assertion. */
fun List<NoteBlock>.shape(): List<String> = map { "${it.id}:${it.type.name.lowercase()}:${it.indent}:${it.plainText}" }
