import Foundation

/// Closes a shared ViewModel exactly once. SwiftUI views have no `deinit`, so the object that owns the
/// screen's `ScreenModel` closes its lease when it is released; a second call is a no-op.
final class SharedViewModelLease: @unchecked Sendable {

    // MARK: - Properties
    private let lock = NSLock()
    private var release: (() -> Void)?

    var isClosed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return release == nil
    }

    // MARK: - Init
    init(_ release: @escaping () -> Void) {
        self.release = release
    }

    // MARK: - Methods
    func close() {
        lock.lock()
        let action = release
        release = nil
        lock.unlock()
        action?()
    }
}
