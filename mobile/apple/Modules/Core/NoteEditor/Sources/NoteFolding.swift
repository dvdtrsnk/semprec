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
