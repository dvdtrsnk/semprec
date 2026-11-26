import SwiftUI

/// The device's output volume as the hold needs it: what it is, a way to move it to its maximum, and when it changes.
/// The one conformance is `MediaPlayerVolume`, which exists on iOS only; tests script their own.
@MainActor
protocol SystemVolume: AnyObject {

    /// The output volume from 0 to 1.
    var level: Float { get }

    /// Moves the output volume to its maximum; false when the system's volume control is not there to move.
    func raiseToMaximum() -> Bool

    /// One element each time the output volume changes, for as long as the stream is consumed.
    func changes() -> AsyncStream<Void>
}

/// Holds the device's volume at its maximum for as long as `run()` is awaited, so that turning it down cannot silence
/// an alarm. It raises the volume once when it starts and again each time the system reports a change below the
/// maximum, so it waits on those reports and polls nothing. Only when the system's volume control is not there yet,
/// which it is not until the hidden view that hosts it is laid out, it tries again a few times at a short interval and
/// then gives up until the next change.
@MainActor
final class VolumeHold {

    // MARK: - Dependencies
    private let volume: any SystemVolume
    private let retryDelay: Duration
    private let attempts: Int

    // MARK: - Init
    init(volume: any SystemVolume, retryDelay: Duration = .milliseconds(250), attempts: Int = 8) {
        self.volume = volume
        self.retryDelay = retryDelay
        self.attempts = attempts
    }

    // MARK: - Methods
    /// Holds the volume until the surrounding task is cancelled, which ends the hold and stops listening.
    func run() async {
        let changes = volume.changes()
        await raise()
        for await _ in changes {
            await raise()
        }
    }
}

// MARK: - Private
private extension VolumeHold {

    func raise() async {
        for attempt in 0..<attempts {
            if volume.level >= 1 || volume.raiseToMaximum() { return }
            guard attempt + 1 < attempts else { return }
            do {
                try await Task.sleep(for: retryDelay)
            } catch {
                // Cancelling the task is how the hold ends, so the error of the wait is not one to report.
                return
            }
        }
    }
}

/// An invisible view that holds the device's volume at its maximum while `isHeld` is true. The hold lives with the
/// view's task, so the view leaving the screen or `isHeld` turning false ends it. iOS lets an app set the volume only
/// through the system's volume control, which this view hosts out of sight with undocumented UIKit internals (see
/// `docs/adr/2026-11-26-the-wake-guard-holds-the-volume-up-with-undocumented-uikit-internals.md`); macOS has nothing
/// to hold, so there it shows nothing and does nothing.
public struct DeviceVolumeHold: View {

    // MARK: - Dependencies
    private let isHeld: Bool

    // MARK: - Init
    public init(isHeld: Bool) {
        self.isHeld = isHeld
    }

    // MARK: - Body
    public var body: some View {
        #if os(iOS)
        MediaPlayerVolumeHost(isHeld: isHeld)
        #else
        EmptyView()
        #endif
    }
}
