import CoreKit
import DesignSystem
import SwiftUI

/// What a swipe on a block does at each of its three thresholds. To the right: indenting, the list menu and the style
/// menu; to the left: outdenting, switching a to-do and selecting. A short swipe so moves a list item a level deeper
/// or back. While a block is edited a swipe only indents (right) or outdents (left) it by one level.
enum NoteSwipeStep: Equatable {

    case listMenu
    case styleMenu
    case outdent
    case todo
    case select
    case indent

    /// How far a swipe goes to reach the first, second and third threshold.
    static let thresholds: [CGFloat] = [40, 105, 190]

    /// The step a swipe of `translation` reached, if any; an edited block has only its indent.
    static func reached(_ translation: CGFloat, editing: Bool = false) -> NoteSwipeStep? {
        let level = thresholds.filter { abs(translation) >= $0 }.count
        let steps: [NoteSwipeStep] = switch (translation > 0, editing) {
        case (true, true): [.indent]
        case (false, true): [.outdent]
        case (true, false): [.indent, .listMenu, .styleMenu]
        case (false, false): [.outdent, .todo, .select]
        }
        return level == 0 ? nil : steps[min(level, steps.count) - 1]
    }

    /// Whether the step can do anything to `block`; one that cannot is shown grey and does nothing.
    /// Whether the step can apply to `block`, which cannot be outdented below `indentFloor`
    /// (`NoteFolding.indentFloor`).
    func isValid(for block: NoteEditorBlock, indentFloor: Int = 0) -> Bool {
        switch self {
        case .outdent: block.indent > indentFloor
        case .indent: block.indent < 5
        case .listMenu, .styleMenu, .todo: block.type != .page
        case .select: true
        }
    }

    func title(for block: NoteEditorBlock) -> LocalizedStringKey {
        switch self {
        case .listMenu: "noteEditor.swipe.list"
        case .styleMenu: "noteEditor.bar.style"
        case .outdent: "noteEditor.bar.outdent"
        case .indent: "noteEditor.bar.indent"
        case .todo: block.type == .todo ? "noteEditor.swipe.untodo" : "noteEditor.bar.todo"
        case .select: "noteEditor.swipe.select"
        }
    }

    var systemImage: String {
        switch self {
        case .listMenu: "list.bullet"
        case .styleMenu: "paragraphsign"
        case .outdent: "decrease.indent"
        case .indent: "increase.indent"
        case .todo: "checkmark.square"
        case .select: "checkmark.circle"
        }
    }

    var tint: Color {
        switch self {
        case .listMenu: .blue
        case .styleMenu: .indigo
        case .outdent: .orange
        case .indent: .orange
        case .todo: .green
        case .select: .teal
        }
    }

    /// The menu the step opens, for the steps that choose from one.
    var menu: NoteMenuKind? {
        switch self {
        case .listMenu: .list
        case .styleMenu: .style
        default: nil
        }
    }
}

/// One choice of a swipe menu: the type it sets, and for a heading whether it folds what is under it; the block keeps
/// its indent.
struct NoteMenuOption: Equatable, Identifiable {

    let id: Int
    let title: LocalizedStringKey
    let type: NoteEditorBlockType
    var toggle = false

    /// Whether the option folds what is under the block: a toggle, or a toggle heading.
    var folds: Bool { toggle || type == .toggle }

    /// The edits that give `block` this option's type.
    func edits(for block: NoteEditorBlock) -> [NoteEditorBlockEdit] {
        [.setType(blockIds: [block.id], type: type, toggle: toggle)]
    }
}

/// The two menus a swipe opens: the list menu and the style menu.
enum NoteMenuKind: Equatable {

    case list
    case style

    var options: [NoteMenuOption] {
        switch self {
        case .list:
            [
                NoteMenuOption(id: 0, title: "noteEditor.menu.list.none", type: .text),
                NoteMenuOption(id: 1, title: "noteEditor.menu.list.bullet", type: .bullet),
                NoteMenuOption(id: 2, title: "noteEditor.menu.list.number", type: .number),
                NoteMenuOption(id: 3, title: "noteEditor.type.todo", type: .todo),
                NoteMenuOption(id: 4, title: "noteEditor.type.toggle", type: .toggle)
            ]
        case .style:
            [
                NoteMenuOption(id: 0, title: "noteEditor.type.text", type: .text),
                NoteMenuOption(id: 1, title: "noteEditor.type.heading1", type: .heading1),
                NoteMenuOption(id: 2, title: "noteEditor.type.heading2", type: .heading2),
                NoteMenuOption(id: 3, title: "noteEditor.type.heading3", type: .heading3),
                NoteMenuOption(id: 4, title: "noteEditor.type.toggleHeading1", type: .heading1, toggle: true),
                NoteMenuOption(id: 5, title: "noteEditor.type.toggleHeading2", type: .heading2, toggle: true),
                NoteMenuOption(id: 6, title: "noteEditor.type.toggleHeading3", type: .heading3, toggle: true),
                NoteMenuOption(id: 7, title: "noteEditor.type.quote", type: .quote)
            ]
        }
    }
}
