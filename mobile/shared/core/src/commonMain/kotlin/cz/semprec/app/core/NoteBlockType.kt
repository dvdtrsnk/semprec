package cz.semprec.app.core

/** The block types of a page document (docs/adr/2026-10-28-block-model-for-page-documents.md); [PAGE] is a subpage. */
enum class NoteBlockType { TEXT, H1, H2, H3, BULLET, NUMBER, TODO, QUOTE, PAGE }
