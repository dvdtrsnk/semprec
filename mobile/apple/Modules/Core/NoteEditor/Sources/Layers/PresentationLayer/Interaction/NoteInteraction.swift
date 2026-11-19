import Combine
import CoreGraphics
import CoreKit

/// A swipe under way on one block: how far it went, where the finger is, and the step it reached.
struct NoteSwipeState: Equatable {

    let blockId: String
    var translation: CGFloat
    var step: NoteSwipeStep?
}

/// A swipe menu: opened under the finger at `anchor`; `highlighted` follows the finger without lifting it. A menu
/// left open after the finger lifted (`pinned`) waits for a tap.
struct NoteMenuState: Equatable {

    let blockId: String
    let kind: NoteMenuKind
    let anchor: CGPoint
    var highlighted: Int?
    var pinned = false
}

/// Blocks moved by their handle: the blocks, where the finger is, and the index in the note they would go to.
struct NoteDragState: Equatable {

    let blockIds: [String]
    var location: CGPoint
    var target: Int
}

/// What the person does with whole blocks by touch: swipes with their thresholds and menus, selecting (by tap or by
/// dragging sideways and then over a range) and moving blocks by their handle. Locations are in the coordinate space
/// of the blocks (`NoteEditorMetrics.space`), where `rowFrames` are measured.
@MainActor
final class NoteInteraction: ObservableObject {

    // MARK: - Published Properties
    @Published private(set) var swipe: NoteSwipeState?
    @Published private(set) var menu: NoteMenuState?
    @Published private(set) var selecting = false
    @Published private(set) var selected: Set<String> = []
    @Published private(set) var drag: NoteDragState?

    /// Where each block is laid out.
    var rowFrames: [String: CGRect] = [:]

    /// The height of one menu option.
    static let optionHeight: CGFloat = 44

    /// Set once a drag on a block went sideways (`true`) or along the page (`false`).
    private var sideways: Bool?
    /// The selection a range drag started from, and the block it started on.
    private var rangeStart: (base: Set<String>, blockId: String)?

    // MARK: - Methods
    var isActive: Bool { swipe != nil || drag != nil || rangeStart != nil || (menu.map { !$0.pinned } ?? false) }

    /// A drag on `block` moved by `translation` to `location`.
    func dragged(_ block: NoteEditorBlock, by translation: CGSize, at location: CGPoint, offersSubpages: Bool) {
        if sideways == nil { sideways = abs(translation.width) > 2 * abs(translation.height) }
        guard sideways == true else { return }
        if selecting {
            selectRange(from: block.id, to: location)
        } else if var open = menu, !open.pinned {
            open.highlighted = option(at: location, in: open)
            menu = open
        } else {
            follow(block, translation: translation, at: location, offersSubpages: offersSubpages)
        }
    }

    /// The finger lifted from a drag on `block`; the edits it asks for.
    func released(_ block: NoteEditorBlock) -> [NoteEditorBlockEdit] {
        defer {
            sideways = nil
            rangeStart = nil
            swipe = nil
        }
        if var open = menu, !open.pinned {
            let option = open.kind.options.first { $0.id == open.highlighted }
            if let option {
                menu = nil
                return option.edits(for: block)
            }
            open.pinned = true
            menu = open
            return []
        }
        guard let step = swipe?.step, step.isValid(for: block) else { return [] }
        switch step {
        case .outdent: return [.shiftIndent(blockIds: [block.id], delta: -1)]
        case .todo: return [.toggleType(blockIds: [block.id], type: .todo)]
        case .subpage: return [.makeSubpage(blockId: block.id)]
        case .select:
            startSelecting(with: block.id)
            return []
        case .listMenu, .styleMenu:
            menu = step.menu.map {
                NoteMenuState(blockId: block.id, kind: $0, anchor: anchor(of: block.id), pinned: true)
            }
            return []
        }
    }

    /// The edits a tapped option of the open menu asks for.
    func pick(_ option: NoteMenuOption, for block: NoteEditorBlock) -> [NoteEditorBlockEdit] {
        menu = nil
        return option.edits(for: block)
    }

    func closeMenu() {
        menu = nil
    }

    // MARK: - Selection
    func startSelecting(with blockId: String? = nil) {
        selecting = true
        selected = blockId.map { [$0] } ?? []
    }

    func stopSelecting() {
        selecting = false
        selected = []
    }

    func toggle(_ blockId: String) {
        if selected.contains(blockId) { selected.remove(blockId) } else { selected.insert(blockId) }
    }

    func selectAll(_ blocks: [NoteEditorBlock]) {
        selected = selected.count == blocks.count ? [] : Set(blocks.map(\.id))
    }

    /// The selected blocks in the order of the note.
    func selectedIds(in blocks: [NoteEditorBlock]) -> [String] {
        blocks.map(\.id).filter(selected.contains)
    }

    // MARK: - Moving
    /// The handle of `block` was dragged to `location`: the block moves, with the selection when it is in it.
    func moved(_ block: NoteEditorBlock, to location: CGPoint, in blocks: [NoteEditorBlock]) {
        let ids = drag?.blockIds
            ?? (selected.contains(block.id) ? selectedIds(in: blocks) : [block.id])
        drag = NoteDragState(blockIds: ids, location: location, target: target(at: location, moving: ids, in: blocks))
    }

    /// The handle was let go: the one move it asks for, unless the blocks stay where they were.
    func dropped(in blocks: [NoteEditorBlock]) -> [NoteEditorBlockEdit] {
        defer { drag = nil }
        let indices = blocks.indices.filter { drag?.blockIds.contains(blocks[$0].id) == true }
        guard let drag, let first = indices.first, let last = indices.last else { return [] }
        // Blocks that lie together and are dropped among themselves stay where they are.
        let staysPut = indices.count == last - first + 1 && (first...(last + 1)).contains(drag.target)
        return staysPut ? [] : [.move(blockIds: drag.blockIds, targetIndex: drag.target)]
    }

    /// The index in the note before which blocks dropped at `location` go: before the first other block whose middle
    /// is below the finger, or at the end.
    func target(at location: CGPoint, moving ids: [String], in blocks: [NoteEditorBlock]) -> Int {
        for (index, block) in blocks.enumerated() where !ids.contains(block.id) {
            if let frame = rowFrames[block.id], frame.midY > location.y { return index }
        }
        return blocks.count
    }
}

// MARK: - Private
private extension NoteInteraction {

    func follow(_ block: NoteEditorBlock, translation: CGSize, at location: CGPoint, offersSubpages: Bool) {
        let step = NoteSwipeStep.reached(translation.width, offersSubpages: offersSubpages)
        swipe = NoteSwipeState(blockId: block.id, translation: translation.width, step: step)
        // A finger that reached a menu's step and then moves along the page opens the menu under it.
        if let kind = step?.menu, step?.isValid(for: block) == true, abs(translation.height) > 24 {
            menu = NoteMenuState(blockId: block.id, kind: kind, anchor: location)
            swipe = nil
        }
    }

    func option(at location: CGPoint, in menu: NoteMenuState) -> Int? {
        let row = Int(((location.y - menu.anchor.y) / Self.optionHeight).rounded(.down))
        return menu.kind.options.indices.contains(row) ? menu.kind.options[row].id : nil
    }

    func anchor(of blockId: String) -> CGPoint {
        let frame = rowFrames[blockId] ?? .zero
        return CGPoint(x: frame.minX + 40, y: frame.maxY)
    }

    /// Selects every block between the one a range drag started on and the one under the finger.
    func selectRange(from blockId: String, to location: CGPoint) {
        if rangeStart == nil { rangeStart = (selected, blockId) }
        guard let start = rangeStart, let startFrame = rowFrames[start.blockId] else { return }
        let low = min(startFrame.minY, location.y)
        let high = max(startFrame.maxY, location.y)
        let covered = rowFrames.filter { $0.value.maxY > low && $0.value.minY < high }.keys
        selected = start.base.union(covered)
    }
}
