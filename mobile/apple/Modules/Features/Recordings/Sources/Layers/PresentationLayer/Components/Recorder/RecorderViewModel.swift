import Combine
import CoreKit
import Foundation

/// Thin adapter between a recorder panel and its shared screen model: republishes the state and forwards intents. It
/// owns the model; releasing it closes the shared ViewModel, which ends a take that is still open.
@MainActor
final class RecorderViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any RecorderScreenModel

    // MARK: - Published Properties
    @Published private(set) var state: RecorderState

    // MARK: - Init
    init(model: any RecorderScreenModel) {
        self.model = model
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state until the screen's task is cancelled, and calls `onUploaded` once for each recording that
    /// reached the server.
    func observe(onUploaded: @escaping @MainActor () -> Void) async {
        await model.observe(
            onState: { [weak self] in self?.state = $0 },
            onEffect: { effect in
                switch effect {
                case .uploaded: onUploaded()
                }
            }
        )
    }

    func send(_ action: RecorderAction) {
        model.send(action)
    }

    /// Sends a file the person picked as a recording. The model copies it while the app may still read it, which is
    /// only while this call runs.
    func sendImport(of url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        model.send(.importFile(path: url.path))
    }
}
