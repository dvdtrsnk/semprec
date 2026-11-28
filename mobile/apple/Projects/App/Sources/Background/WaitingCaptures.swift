import CoreKit
import Foundation

/// The Inbox captures that wait in the device's outbox, as the app's sending of them sees them: it sends them and asks
/// whether any still wait. `InboxShortcutCapture` is the production one; tests pass a double.
@MainActor
protocol WaitingCaptures: AnyObject, Sendable {

    /// Sends the captures that wait now and answers whether none of the person signed in is left. Cancelling it stops
    /// the sending, unless another trigger of the outbox waits for it too.
    func send() async -> Bool

    /// Whether a capture of the person signed in waits for the server: `.nothing` when nobody is signed in, and
    /// `.unknown` when it could not be counted.
    func capturesWait() async -> InboxShortcutCapture.Waiting
}

// MARK: - Protocol conformance
extension InboxShortcutCapture: WaitingCaptures {}
