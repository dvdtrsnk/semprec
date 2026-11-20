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
