import Combine
import CoreKit
import Foundation

/// Thin adapter between the AI usage screen and its shared screen model: republishes the state and forwards intents.
/// It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class AiUsageViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any AiUsageScreenModel

    // MARK: - Published Properties
    @Published private(set) var state: AiUsageState

    // MARK: - Init
    init(model: any AiUsageScreenModel) {
        self.model = model
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state until the screen's task is cancelled.
    func observe() async {
        await model.observe(onState: { [weak self] in self?.state = $0 })
    }

    func retry() {
        model.send(.retry)
    }

    func select(_ period: UsagePeriod) {
        model.send(.selectPeriod(period))
    }

    func pick(_ index: Int) {
        model.send(.pickPoint(index))
    }
}
