import SwiftUI

/// What selection mode feels like: a light tap when it starts, and the selection tick when a block is selected or
/// let go in it.
struct NoteSelectionHaptic: Equatable {

    let selecting: Bool
    let selected: Set<String>

    @MainActor
    init(_ interaction: NoteInteraction) {
        selecting = interaction.selecting
        selected = interaction.selected
    }

    func feedback(to next: Self) -> SensoryFeedback? {
        if !selecting { return next.selecting ? .impact(weight: .light) : nil }
        return next.selecting && next.selected != selected ? .selection : nil
    }
}
