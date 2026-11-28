import CoreKit
import SwiftUI

/// The keys of a hardware keyboard in the edited block: Return splits, Shift-Return breaks the line, Command-Return
/// checks a to-do; Tab indents; the arrows leave the block at its ends; Delete at the end joins the next block;
/// Escape ends editing; Command-B, I, E and K format and link.
struct NoteEditorKeys: ViewModifier {

    // MARK: - Dependencies
    let blockId: String
    let length: Int
    let cursor: (start: Int, end: Int)
    let onTyping: (NoteEditorTyping) -> Void
    let onKey: (NoteEditorKey) -> Void
    let onSoftBreak: () -> Void

    // MARK: - Body
    func body(content: Content) -> some View {
        content
            .onKeyPress(.return, phases: .down) { press in
                if press.modifiers.contains(.shift) {
                    onSoftBreak()
                } else if press.modifiers.contains(.command) {
                    onTyping(.commandEnter(blockId: blockId))
                } else {
                    onTyping(.enter(blockId: blockId, offset: cursor.start))
                }
                return .handled
            }
            .onKeyPress(.tab, phases: .down) { press in
                onKey(.indent(press.modifiers.contains(.shift) ? -1 : 1))
                return .handled
            }
            .onKeyPress(.upArrow, phases: .down) { _ in leave(.previous, when: cursor.end == 0) }
            .onKeyPress(.downArrow, phases: .down) { _ in leave(.next, when: cursor.start == length) }
            .onKeyPress(.deleteForward, phases: .down) { _ in
                guard cursor.start == length, cursor.end == length else { return .ignored }
                onTyping(.deleteAtEnd(blockId: blockId))
                return .handled
            }
            .onKeyPress(.escape, phases: .down) { _ in
                onKey(.done)
                return .handled
            }
            .onKeyPress(characters: Self.shortcuts, phases: .down) { press in
                guard press.modifiers.contains(.command) else { return .ignored }
                return shortcut(press.characters.lowercased())
            }
    }
}

// MARK: - Private
private extension NoteEditorKeys {

    static let shortcuts = CharacterSet(charactersIn: "biekBIEK")

    func leave(_ key: NoteEditorKey, when atEnd: Bool) -> KeyPress.Result {
        guard atEnd else { return .ignored }
        onKey(key)
        return .handled
    }

    func shortcut(_ character: String) -> KeyPress.Result {
        let mark: NoteEditorMark? = switch character {
        case "b": .bold
        case "i": .italic
        case "e": .code
        default: nil
        }
        if let mark {
            onTyping(.toggleMark(blockId: blockId, start: cursor.start, end: cursor.end, mark: mark))
        } else {
            onKey(.link)
        }
        return .handled
    }
}
