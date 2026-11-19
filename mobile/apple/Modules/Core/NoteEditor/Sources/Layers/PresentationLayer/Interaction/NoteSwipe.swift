import CoreKit
import DesignSystem
import SwiftUI

/// What a swipe on a block does at each of its three thresholds. To the right: the list menu, the style menu and
/// making a subpage; to the left: outdenting, switching a to-do and selecting.
enum NoteSwipeStep: Equatable {

    case listMenu
    case styleMenu
    case subpage
    case outdent
    case todo
    case select

    /// How far a swipe goes to reach the first, second and third threshold.
    static let thresholds: [CGFloat] = [40, 105, 190]

    /// The step a swipe of `translation` reached, if any; the light variant has no third step to the right.
    static func reached(_ translation: CGFloat, offersSubpages: Bool) -> NoteSwipeStep? {
        let level = thresholds.filter { abs(translation) >= $0 }.count
        let steps: [NoteSwipeStep] = translation > 0
            ? (offersSubpages ? [.listMenu, .styleMenu, .subpage] : [.listMenu, .styleMenu])
            : [.outdent, .todo, .select]
        return level == 0 ? nil : steps[min(level, steps.count) - 1]
    }

    /// Whether the step can do anything to `block`; one that cannot is shown grey and does nothing.
    func isValid(for block: NoteEditorBlock) -> Bool {
        switch self {
        case .outdent: block.indent > 0
        case .listMenu, .styleMenu, .todo, .subpage: block.type != .page
        case .select: true
        }
    }

    func title(for block: NoteEditorBlock) -> LocalizedStringKey {
        switch self {
        case .listMenu: "noteEditor.swipe.list"
        case .styleMenu: "noteEditor.bar.style"
        case .subpage: block.type == .page ? "noteEditor.swipe.alreadyPage" : "noteEditor.swipe.page"
        case .outdent: "noteEditor.bar.outdent"
        case .todo: block.type == .todo ? "noteEditor.swipe.untodo" : "noteEditor.bar.todo"
        case .select: "noteEditor.swipe.select"
        }
    }

    var systemImage: String {
        switch self {
        case .listMenu: "list.bullet"
        case .styleMenu: "paragraphsign"
        case .subpage: "doc.badge.plus"
        case .outdent: "decrease.indent"
        case .todo: "checkmark.square"
        case .select: "checkmark.circle"
        }
    }

    var tint: Color {
        switch self {
        case .listMenu: .blue
        case .styleMenu: .indigo
        case .subpage: .purple
        case .outdent: .orange
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

/// One choice of a swipe menu: the type it sets and, for a list of a level, the indent it sets too.
struct NoteMenuOption: Equatable, Identifiable {

    let id: Int
    let title: LocalizedStringKey
    let type: NoteEditorBlockType
    let indent: Int?

    /// The edits that give `block` this option's type (and indent).
    func edits(for block: NoteEditorBlock) -> [NoteEditorBlockEdit] {
        var edits: [NoteEditorBlockEdit] = [.setType(blockIds: [block.id], type: type)]
        if let indent, indent != block.indent {
            edits.append(.shiftIndent(blockIds: [block.id], delta: indent - block.indent))
        }
        return edits
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
                NoteMenuOption(id: 0, title: "noteEditor.menu.list.none", type: .text, indent: nil),
                NoteMenuOption(id: 1, title: "noteEditor.menu.list.bullet", type: .bullet, indent: 0),
                NoteMenuOption(id: 2, title: "noteEditor.menu.list.bullet2", type: .bullet, indent: 1),
                NoteMenuOption(id: 3, title: "noteEditor.menu.list.bullet3", type: .bullet, indent: 2),
                NoteMenuOption(id: 4, title: "noteEditor.menu.list.number", type: .number, indent: 0),
                NoteMenuOption(id: 5, title: "noteEditor.menu.list.number2", type: .number, indent: 1),
                NoteMenuOption(id: 6, title: "noteEditor.type.todo", type: .todo, indent: nil)
            ]
        case .style:
            [
                NoteMenuOption(id: 0, title: "noteEditor.type.text", type: .text, indent: nil),
                NoteMenuOption(id: 1, title: "noteEditor.type.heading1", type: .heading1, indent: nil),
                NoteMenuOption(id: 2, title: "noteEditor.type.heading2", type: .heading2, indent: nil),
                NoteMenuOption(id: 3, title: "noteEditor.type.heading3", type: .heading3, indent: nil),
                NoteMenuOption(id: 4, title: "noteEditor.type.quote", type: .quote, indent: nil)
            ]
        }
    }
}
