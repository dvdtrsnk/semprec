import CoreKit
import Foundation

@testable import Alldots

/// The waiting Inbox captures of a test: `send()` answers `sendAnswer`, or with `holdsSend` waits until its task is
/// cancelled and answers false; `capturesWait()` answers `waits`. It counts the calls.
@MainActor
final class CapturesDouble: WaitingCaptures {

    // MARK: - Properties
    var sendAnswer = true
    var holdsSend = false
    var waits: InboxShortcutCapture.Waiting = .nothing
    /// Called when a send starts.
    var onSend: (() -> Void)?
    private(set) var sends = 0
    private(set) var sendWasCancelled = false
    private(set) var waitChecks = 0

    // MARK: - Methods
    func send() async -> Bool {
        sends += 1
        onSend?()
        guard holdsSend else { return sendAnswer }
        try? await Task.sleep(for: .seconds(3600))
        sendWasCancelled = Task.isCancelled
        return false
    }

    func capturesWait() async -> InboxShortcutCapture.Waiting {
        waitChecks += 1
        return waits
    }
}
