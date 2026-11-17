import Combine
import CoreKit
import Foundation

/// Thin adapter between the devices screen and its shared screen model: republishes the state and forwards intents.
/// It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class DevicesViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any DevicesScreenModel

    // MARK: - Published Properties
    @Published private(set) var state: DevicesState

    // MARK: - Init
    init(model: any DevicesScreenModel) {
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

    func ask(_ device: DeviceItem) {
        model.send(.ask(deviceId: device.id))
    }

    func askOthers() {
        model.send(.askOthers)
    }

    func cancel() {
        model.send(.cancel)
    }

    func confirm() {
        model.send(.confirm)
    }

    func dismissFailure() {
        model.send(.dismissFailure)
    }
}
