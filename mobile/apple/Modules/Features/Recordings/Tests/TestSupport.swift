import CoreKit
import XCTest

@testable import RecordingsFeature

/// Waits until `condition` holds, for at most two seconds.
@MainActor
func eventually(_ condition: @MainActor () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
    for _ in 0..<200 {
        if condition() { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("The condition did not hold in time", file: file, line: line)
}

/// A router that remembers what the screens asked it to show.
@MainActor
final class RouterSpy: RecordingsRouting {

    // MARK: - Properties
    private(set) var calls: [String] = []

    // MARK: - Protocol conformance
    func showTranscript(recordingId: String) {
        calls.append("transcript:\(recordingId)")
    }

    func showEvent(eventId: String) {
        calls.append("event:\(eventId)")
    }

    func showNotes(eventId: String) {
        calls.append("notes:\(eventId)")
    }

    func showTask(taskId: String) {
        calls.append("task:\(taskId)")
    }

    func showEventDetails(eventId: String) {
        calls.append("details:\(eventId)")
    }
}
