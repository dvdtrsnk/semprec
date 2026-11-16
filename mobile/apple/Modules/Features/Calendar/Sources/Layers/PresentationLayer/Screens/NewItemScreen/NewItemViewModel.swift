import Combine
import CoreKit
import Foundation

/// Thin adapter between the new item sheet and its shared screen model: republishes the state, hands the form over
/// and records that the item was created, which closes the sheet. It owns the model; releasing it closes the shared
/// ViewModel behind the model.
@MainActor
final class NewItemViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any NewItemScreenModel

    // MARK: - Published Properties
    @Published private(set) var state: NewItemState
    /// The id of the created item once the shared ViewModel reports it; the sheet then dismisses itself.
    @Published private(set) var createdItemId: String?

    // MARK: - Init
    init(model: any NewItemScreenModel) {
        self.model = model
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state and effects until the screen's task is cancelled.
    func observe() async {
        await model.observe(
            onState: { [weak self] in self?.state = $0 },
            onEffect: { [weak self] in self?.handle($0) }
        )
    }

    /// Creates the item the form describes.
    func create(_ form: NewItemForm) {
        model.send(.create(form.draft))
    }

    /// The person changed a field: a failure shown for the previous values no longer applies.
    func edited() {
        guard case .failed = state.phase else { return }
        model.send(.edited)
    }
}

// MARK: - Private
private extension NewItemViewModel {

    func handle(_ effect: NewItemEffect) {
        switch effect {
        case .created(let itemId): createdItemId = itemId
        }
    }
}
