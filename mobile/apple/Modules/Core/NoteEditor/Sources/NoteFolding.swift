import CoreKit

/// Which blocks closed toggles hide: a toggle or a toggle heading hides its children, the blocks right after it that
/// are indented deeper. Which toggles are closed is kept on the device only.
enum NoteFolding {

    /// Whether `block` folds what is under it.
    static func folds(_ block: NoteEditorBlock) -> Bool {
        block.type == .toggle || block.toggle
    }

    /// The blocks left when the toggles in `folded` are closed.
    static func visible(_ blocks: [NoteEditorBlock], folded: Set<String>) -> [NoteEditorBlock] {
        let hidden = hiders(blocks, folded: folded)
        return blocks.filter { hidden[$0.id] == nil }
    }

    /// Whether the toggle at `index` has no children.
    static func isEmpty(at index: Int, in blocks: [NoteEditorBlock]) -> Bool {
        guard blocks.indices.contains(index + 1) else { return true }
        return blocks[index + 1].indent <= blocks[index].indent
    }

    /// `ids` with the children of every toggle among them, in the order of the note: a toggle moves, indents,
    /// duplicates and goes away with what it holds.
    static func withChildren(_ ids: [String], in blocks: [NoteEditorBlock]) -> [String] {
        let chosen = Set(ids)
        var result: [String] = []
        var holder: NoteEditorBlock?
        for block in blocks {
            if let current = holder, block.indent > current.indent {
                result.append(block.id)
                continue
            }
            holder = nil
            guard chosen.contains(block.id) else { continue }
            result.append(block.id)
            if folds(block) { holder = block }
        }
        return result
    }

    /// The least indent `blockId` may have: one more than the deepest toggle it is inside, so outdenting never takes
    /// a block out of its toggle; 0 outside any.
    static func indentFloor(of blockId: String, in blocks: [NoteEditorBlock]) -> Int {
        guard let index = blocks.firstIndex(where: { $0.id == blockId }) else { return 0 }
        var level = blocks[index].indent
        var floor = 0
        for above in blocks[..<index].reversed() where above.indent < level {
            level = above.indent
            if folds(above) { floor = max(floor, level + 1) }
            if level == 0 { break }
        }
        return floor
    }

    /// Whether a block at `level` right before `target` would be inside a toggle; `ids` are the blocks being moved.
    static func isInsideToggle(
        level: Int,
        before target: Int,
        in blocks: [NoteEditorBlock],
        skipping ids: [String]
    ) -> Bool {
        var level = level
        let above = blocks[..<min(target, blocks.count)].reversed().filter { !ids.contains($0.id) }
        for above in above where above.indent < level {
            if folds(above) { return true }
            level = above.indent
            if level == 0 { break }
        }
        return false
    }

    /// `edit` applied to the children of the toggles it changes too: a toggle indents, moves, duplicates and goes away
    /// with what it holds. An outdent leaves out the blocks it would take out of their toggle; `nil` when none can go.
    static func applying(_ edit: NoteEditorBlockEdit, in blocks: [NoteEditorBlock]) -> NoteEditorBlockEdit? {
        switch edit {
        case .shiftIndent(let ids, let delta):
            let kept = delta >= 0 ? ids : ids.filter { id in
                guard let block = blocks.first(where: { $0.id == id }) else { return false }
                return block.indent + delta >= indentFloor(of: id, in: blocks)
            }
            return kept.isEmpty ? nil : .shiftIndent(blockIds: withChildren(kept, in: blocks), delta: delta)
        case .move(let ids, let target, let delta):
            return .move(blockIds: withChildren(ids, in: blocks), targetIndex: target, indentDelta: delta)
        case .duplicate(let ids): return .duplicate(blockIds: withChildren(ids, in: blocks))
        case .delete(let ids): return .delete(blockIds: withChildren(ids, in: blocks))
        default: return edit
        }
    }

    /// `folded` with every toggle that hides `blockId` opened.
    static func revealing(_ blockId: String, in blocks: [NoteEditorBlock], folded: Set<String>) -> Set<String> {
        var open = folded
        while let hider = hiders(blocks, folded: open)[blockId] { open.remove(hider) }
        return open
    }

    /// Each hidden block's id with the id of the closed toggle that hides it.
    private static func hiders(_ blocks: [NoteEditorBlock], folded: Set<String>) -> [String: String] {
        var hidden: [String: String] = [:]
        var hider: NoteEditorBlock?
        for block in blocks {
            if let current = hider, hides(current, block) {
                hidden[block.id] = current.id
                continue
            }
            let isClosed = folds(block) && folded.contains(block.id)
            hider = isClosed ? block : nil
        }
        return hidden
    }

    private static func hides(_ toggle: NoteEditorBlock, _ block: NoteEditorBlock) -> Bool {
        block.indent > toggle.indent
    }
}
