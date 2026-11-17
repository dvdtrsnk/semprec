import XCTest

// MARK: - Waiting
extension XCTestCase {

    /// Returns once `condition` holds, or once `timeout` passed; the caller asserts the condition afterwards.
    @MainActor
    func eventually(timeout: Duration = .seconds(5), _ condition: @MainActor () -> Bool) async throws {
        let deadline = ContinuousClock.now + timeout
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
    }
}
