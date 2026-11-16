import Combine
import CoreKit
import Foundation

/// Thin adapter between the compose screen and its shared screen model: republishes the state and forwards intents.
/// It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class MailComposeViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any MailComposeScreenModel

    // MARK: - Published Properties
    @Published private(set) var state: MailComposeState
    /// Counts the requests to leave the screen; the screen closes whenever it grows.
    @Published private(set) var closeRequests = 0

    // MARK: - Init
    init(model: any MailComposeScreenModel) {
        self.model = model
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state and the request to close until the screen's task is cancelled.
    func observe() async {
        await model.observe(
            onState: { [weak self] in self?.state = $0 },
            onEffect: { [weak self] in self?.route($0) }
        )
    }

    func send(_ action: MailComposeAction) {
        model.send(action)
    }
}

// MARK: - Private
private extension MailComposeViewModel {

    func route(_ effect: MailComposeEffect) {
        switch effect {
        case .close: closeRequests += 1
        }
    }
}
