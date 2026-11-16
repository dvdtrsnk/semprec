@preconcurrency internal import SharedSDK

// MARK: - Notes
extension SharedScreenModelFactory {

    public func makeNotes(itemId: String) -> any NotesScreenModel {
        SharedNotesScreenModel(sdk.notes.notesViewModel(itemId: itemId))
    }
}
