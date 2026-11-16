import Combine
import CoreKit
import Foundation

/// Thin adapter between the account screen and its shared screen model: republishes the state and forwards intents.
/// It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class MailAccountViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any MailAccountScreenModel

    // MARK: - Published Properties
    @Published private(set) var state: MailAccountState
    /// Counts the requests to leave the screen; the screen goes back whenever it grows.
    @Published private(set) var closeRequests = 0

    // MARK: - Init
    init(model: any MailAccountScreenModel) {
        self.model = model
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state and the request to leave until the screen's task is cancelled.
    func observe() async {
        await model.observe(
            onState: { [weak self] in self?.state = $0 },
            onEffect: { [weak self] in self?.route($0) }
        )
    }

    func send(_ action: MailAccountAction) {
        model.send(action)
    }
}

// MARK: - Private
private extension MailAccountViewModel {

    func route(_ effect: MailAccountEffect) {
        switch effect {
        case .removed: closeRequests += 1
        }
    }
}
