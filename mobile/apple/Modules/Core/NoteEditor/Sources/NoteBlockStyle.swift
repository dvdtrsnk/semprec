import CoreKit
import DesignSystem
import SwiftUI

/// How a block looks: its font by type, its colour, and the placeholder an empty one shows.
enum NoteBlockStyle {

    /// The indentation of one level.
    static let indentWidth: CGFloat = 24

    static func font(_ type: NoteEditorBlockType) -> Font {
        switch type {
        case .heading1: .title.bold()
        case .heading2: .title2.bold()
        case .heading3: .title3.weight(.semibold)
        case .quote: .body.italic()
        case .text, .bullet, .number, .todo, .page: .body
        }
    }

    static func isMuted(_ block: NoteEditorBlock) -> Bool {
        block.type == .quote || (block.type == .todo && block.done)
    }

    static func color(_ block: NoteEditorBlock) -> Color {
        isMuted(block) ? Theme.Colors.secondaryText : .primary
    }

    /// The space above a block, more above a heading than between lines of a list.
    static func spacing(above type: NoteEditorBlockType) -> CGFloat {
        switch type {
        case .heading1: 14
        case .heading2: 10
        case .heading3: 6
        case .text, .bullet, .number, .todo, .quote, .page: 2
        }
    }

    /// The placeholder an empty block shows: the note's own when it is its only block, the Markdown hint when an
    /// empty text block is edited, and its type's name otherwise.
    static func placeholder(_ type: NoteEditorBlockType, isOnlyBlock: Bool, isEditing: Bool) -> LocalizedStringKey? {
        switch type {
        case .text where isOnlyBlock: "noteEditor.placeholder.empty"
        case .text: isEditing ? "noteEditor.placeholder.text" : nil
        default: typeName(type)
        }
    }

    static func typeName(_ type: NoteEditorBlockType) -> LocalizedStringKey {
        switch type {
        case .text: "noteEditor.type.text"
        case .heading1: "noteEditor.type.heading1"
        case .heading2: "noteEditor.type.heading2"
        case .heading3: "noteEditor.type.heading3"
        case .bullet: "noteEditor.type.bullet"
        case .number: "noteEditor.type.number"
        case .todo: "noteEditor.type.todo"
        case .quote: "noteEditor.type.quote"
        case .page: "noteEditor.type.page"
        }
    }
}
