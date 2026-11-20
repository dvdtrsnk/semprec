import SwiftUI

/// What selection mode feels like: the selection tick when a block is selected or let go in it. Its start is felt
/// already, as the hold or the swipe that starts it.
struct NoteSelectionHaptic: Equatable {

    let selecting: Bool
    let selected: Set<String>

    @MainActor
    init(_ interaction: NoteInteraction) {
        selecting = interaction.selecting
        selected = interaction.selected
    }

    func feedback(to next: Self) -> SensoryFeedback? {
        selecting && next.selecting && next.selected != selected ? .selection : nil
    }
}
