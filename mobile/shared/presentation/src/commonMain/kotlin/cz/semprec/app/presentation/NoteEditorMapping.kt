package cz.semprec.app.presentation

import cz.semprec.app.domain.InlineRun
import cz.semprec.app.domain.PageBlockType
import cz.semprec.app.domain.note.NoteBlock
import cz.semprec.app.domain.note.NoteMark
import cz.semprec.app.domain.note.NoteMarker
import cz.semprec.app.domain.note.NoteMarkers

internal fun NoteEditorRun.toDomain() = InlineRun(text, bold, italic, code, link)

internal fun InlineRun.toEditor() = NoteEditorRun(text, bold, italic, code, link)

internal fun NoteEditorBlockType.toDomain(): PageBlockType = PageBlockType.valueOf(name)

internal fun NoteEditorMark.toDomain(): NoteMark = NoteMark.valueOf(name)

/** The blocks as the screen shows them, each with the marker it draws. */
internal fun List<NoteBlock>.toEditor(): List<NoteEditorBlock> = zip(NoteMarkers.of(this)) { block, marker ->
    NoteEditorBlock(
        id = block.id,
        type = NoteEditorBlockType.valueOf(block.type.name),
        indent = block.indent,
        done = block.done,
        runs = block.runs.map { it.toEditor() },
        pageId = block.pageId,
        marker = when (marker) {
            is NoteMarker.Bullet -> NoteEditorMarker.Bullet(marker.level)
            is NoteMarker.Number -> NoteEditorMarker.Number(marker.label)
            null -> null
        },
    )
}
