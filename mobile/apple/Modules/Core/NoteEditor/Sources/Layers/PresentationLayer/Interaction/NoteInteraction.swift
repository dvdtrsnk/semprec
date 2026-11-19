import Combine
import CoreGraphics
import CoreKit

/// A swipe under way on one block: how far it went and the step it reached. It is `frozen` while the finger is off
/// the block choosing from the step's menu; the swipe then stays as it was.
struct NoteSwipeState: Equatable {

    let blockId: String
    var translation: CGFloat
    var step: NoteSwipeStep?
    var frozen = false
}

/// A swipe menu next to the block `row`: `below` it or above it, its first option nearest the block. While the finger
/// is down the option as far from the block as the finger is gets highlighted; a menu left open after the finger lifted
/// (`pinned`) waits for a tap.
struct NoteMenuState: Equatable {

    let blockId: String
    let kind: NoteMenuKind
    let row: CGRect
    /// Where across the space the finger was when the menu opened.
    let left: CGFloat
    let below: Bool
    var highlighted: Int?
    var pinned = false
}

/// Blocks being moved: the blocks, where the finger is, and the index in the note they would go to.
struct NoteDragState: Equatable {

    let blockIds: [String]
    var location: CGPoint
    var target: Int
}

/// What the person does with whole blocks by touch: swipes with their thresholds and menus, holding a block (to select
/// it, or to move it by dragging), selecting by tap or by dragging sideways over a range, and moving by the handle.
/// Locations are in the coordinate space of the blocks (`NoteEditorMetrics.space`), where `rowFrames` and `visible`
/// are measured.
@MainActor
final class NoteInteraction: ObservableObject {

    // MARK: - Published Properties
    @Published private(set) var swipe: NoteSwipeState?
    @Published private(set) var menu: NoteMenuState?
    @Published private(set) var selecting = false
    @Published private(set) var selected: Set<String> = []
    @Published private(set) var drag: NoteDragState?
    /// The block a finger holds, before it lifts or moves it.
    @Published private(set) var held: String?
    /// Counted up each time a hold begins, for its haptic.
    @Published private(set) var holds = 0

    /// Where each block is laid out.
    var rowFrames: [String: CGRect] = [:]
    /// The part of the blocks' space on the screen.
    var visible = CGRect.infinite

    /// The height of one menu option.
    static let optionHeight: CGFloat = 48
    /// How far off its block a finger goes before the swipe stops and its menu opens.
    static let offRow: CGFloat = 16

    /// Set once a drag on a block went sideways (`true`) or along the page (`false`).
    private var sideways: Bool?
    /// The selection a range drag started from, and the block it started on.
    private var rangeStart: (base: Set<String>, blockId: String)?
    /// Where the finger of a hold was when it began.
    private var holdStart: CGPoint?

    // MARK: - Methods
    var isActive: Bool {
        swipe != nil || drag != nil || held != nil || rangeStart != nil || (menu.map { !$0.pinned } ?? false)
    }

    /// A drag on `block` moved by `translation` to `location`.
    func dragged(
        _ block: NoteEditorBlock,
        by translation: CGSize,
        at location: CGPoint,
        offersSubpages: Bool,
        editing: Bool = false
    ) {
        guard held == nil else { return }
        if sideways == nil { sideways = abs(translation.width) > 2 * abs(translation.height) }
        guard sideways == true else { return }
        if selecting {
            selectRange(from: block.id, to: location)
            return
        }
        let row = rowFrames[block.id] ?? .zero
        let offRow = location.y > row.maxY + Self.offRow || location.y < row.minY - Self.offRow
        if offRow, let swipe, let kind = swipe.step?.menu, swipe.step?.isValid(for: block) == true {
            choose(from: kind, for: block.id, row: row, at: location)
        } else {
            menu = menu?.pinned == true ? menu : nil
            let step = NoteSwipeStep.reached(translation.width, offersSubpages: offersSubpages, editing: editing)
            swipe = NoteSwipeState(blockId: block.id, translation: translation.width, step: step)
        }
    }

    /// The finger lifted from a drag on `block`; the edits it asks for. Nothing is changed unless the tray under the
    /// block showed what would be.
    func released(_ block: NoteEditorBlock) -> [NoteEditorBlockEdit] {
        defer {
            sideways = nil
            rangeStart = nil
            swipe = nil
        }
        guard held == nil else { return [] }
        if let open = menu, !open.pinned {
            menu = nil
            let option = open.kind.options.first { $0.id == open.highlighted }
            return option?.edits(for: block) ?? []
        }
        guard let step = swipe?.step, step.isValid(for: block) else { return [] }
        switch step {
        case .outdent: return [.shiftIndent(blockIds: [block.id], delta: -1)]
        case .indent: return [.shiftIndent(blockIds: [block.id], delta: 1)]
        case .todo: return [.toggleType(blockIds: [block.id], type: .todo)]
        case .subpage: return [.makeSubpage(blockId: block.id)]
        case .select:
            startSelecting(with: block.id)
            return []
        case .listMenu, .styleMenu:
            let row = rowFrames[block.id] ?? .zero
            menu = step.menu.map { kind in
                NoteMenuState(
                    blockId: block.id,
                    kind: kind,
                    row: row,
                    left: row.minX,
                    below: fits(kind, below: true, row: row),
                    pinned: true
                )
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

    // MARK: - Holding
    /// A finger held `block` long enough: it is lifted, to be selected or moved.
    func hold(_ block: NoteEditorBlock) {
        guard held != block.id else { return }
        held = block.id
        holdStart = nil
        holds += 1
    }

    /// The finger holding `block` is at `location`; once it moves along the page, the block moves with it.
    func holdMoved(_ block: NoteEditorBlock, to location: CGPoint, in blocks: [NoteEditorBlock]) {
        guard held == block.id else { return }
        guard let start = holdStart else {
            holdStart = location
            return
        }
        if drag != nil || abs(location.y - start.y) > 8 { moved(block, to: location, in: blocks) }
    }

    /// The finger holding a block lifted: a block that did not move is selected, one that moved goes where the finger
    /// left it.
    func holdEnded(in blocks: [NoteEditorBlock]) -> [NoteEditorBlockEdit] {
        defer {
            held = nil
            holdStart = nil
        }
        guard let blockId = held else { return [] }
        if drag != nil { return dropped(in: blocks) }
        if selecting { selected.insert(blockId) } else { startSelecting(with: blockId) }
        return []
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
    /// `block` is dragged to `location`: it moves, with the selection when it is in it.
    func moved(_ block: NoteEditorBlock, to location: CGPoint, in blocks: [NoteEditorBlock]) {
        let ids = drag?.blockIds
            ?? (selected.contains(block.id) ? selectedIds(in: blocks) : [block.id])
        drag = NoteDragState(blockIds: ids, location: location, target: target(at: location, moving: ids, in: blocks))
    }

    /// The dragged blocks were let go: the one move it asks for, unless the blocks stay where they were.
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

    /// The finger left the block along the page: the swipe stays as it is and the menu opens on the side the finger
    /// went, or on the other side when it has no room there; the option as far from the block as the finger is gets
    /// highlighted on either side.
    func choose(from kind: NoteMenuKind, for blockId: String, row: CGRect, at location: CGPoint) {
        swipe?.frozen = true
        let downward = location.y > row.maxY
        let open = menu?.pinned == false ? menu : nil
        let below = open?.below ?? (fits(kind, below: downward, row: row) ? downward : !downward)
        let distance = downward ? location.y - row.maxY : row.minY - location.y
        let index = Int((distance / Self.optionHeight).rounded(.down))
        menu = NoteMenuState(
            blockId: blockId,
            kind: kind,
            row: row,
            left: open?.left ?? location.x,
            below: below,
            highlighted: kind.options.indices.contains(index) ? kind.options[index].id : nil
        )
    }

    func fits(_ kind: NoteMenuKind, below: Bool, row: CGRect) -> Bool {
        let height = CGFloat(kind.options.count) * Self.optionHeight
        return below ? row.maxY + height <= visible.maxY : row.minY - height >= visible.minY
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
