import Combine
import CoreKit
import Foundation

/// Thin adapter between the trash screen and its shared screen model: republishes the state, forwards intents and
/// turns the result of a restore into a short notice. It owns the model; releasing it closes the shared ViewModel.
@MainActor
final class TrashViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any TrashScreenModel
    private let noticeDuration: Duration

    // MARK: - Published Properties
    @Published private(set) var state: TrashState
    /// What the last restore came to, for a moment after it.
    @Published private(set) var notice: String?

    // MARK: - Properties
    private var noticeTask: Task<Void, Never>?

    // MARK: - Init
    init(model: any TrashScreenModel, noticeDuration: Duration = .seconds(2.5)) {
        self.model = model
        self.noticeDuration = noticeDuration
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state and shows the notice of each restore until the screen's task is cancelled.
    func observe() async {
        await model.observe(
            onState: { [weak self] in self?.state = $0 },
            onEffect: { [weak self] in self?.show($0) }
        )
    }

    func retry() {
        model.send(.retry)
    }

    func select(_ tab: TrashTab) {
        model.send(.selectTab(tab))
    }

    func loadMore() {
        model.send(.loadMore)
    }

    func toggleSelecting() {
        model.send(.toggleSelecting)
    }

    func toggle(_ id: String) {
        model.send(.toggle(id: id))
    }

    func selectAll() {
        model.send(.selectAll)
    }

    func restore(_ id: String) {
        model.send(.restore(id: id))
    }

    func restoreSelected() {
        model.send(.restoreSelected)
    }

    func dismissFailure() {
        model.send(.dismissFailure)
    }
}

// MARK: - Notice
extension TrashViewModel {

    /// The words of a restore: where the one restored item went, how many were restored, and how many were refused.
    static func notice(restored: Int, refused: Int, databaseName: String?) -> String {
        if refused > 0 {
            return String(format: String(localized: "trash.notice.partial", bundle: .module), restored, refused)
        }
        if restored == 1, let databaseName {
            return String(format: String(localized: "trash.notice.into", bundle: .module), databaseName)
        }
        return String(format: String(localized: "trash.notice.restored", bundle: .module), restored)
    }
}

// MARK: - Private
private extension TrashViewModel {

    func show(_ effect: TrashEffect) {
        switch effect {
        case .restored(let restored, let refused, let databaseName):
            notice = Self.notice(restored: restored, refused: refused, databaseName: databaseName)
            noticeTask?.cancel()
            noticeTask = Task { [weak self, noticeDuration] in
                try? await Task.sleep(for: noticeDuration)
                guard !Task.isCancelled else { return }
                self?.notice = nil
            }
        }
    }
}
