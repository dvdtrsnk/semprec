import Combine
import CoreKit
import Foundation

/// Thin adapter between the Podrobnosti sheet and its shared screen model: republishes the state, forwards intents
/// and tells the sheet when its item was deleted. It owns the model; releasing it closes the shared ViewModel.
@MainActor
final class ItemDetailsViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any ItemDetailsScreenModel

    // MARK: - Published Properties
    @Published private(set) var state: ItemDetailsState
    /// `true` once the item went to the trash, which closes the sheet.
    @Published private(set) var deleted = false

    // MARK: - Init
    init(model: any ItemDetailsScreenModel) {
        self.model = model
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state and effects until the sheet's task is cancelled.
    func observe() async {
        await model.observe(
            onState: { [weak self] in self?.state = $0 },
            onEffect: { [weak self] in self?.route($0) }
        )
    }

    func send(_ action: ItemDetailsAction) {
        model.send(action)
    }
}

// MARK: - Private
private extension ItemDetailsViewModel {

    func route(_ effect: ItemDetailsEffect) {
        switch effect {
        case .deleted: deleted = true
        }
    }
}
