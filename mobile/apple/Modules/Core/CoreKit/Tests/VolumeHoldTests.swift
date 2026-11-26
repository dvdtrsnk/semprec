import XCTest

@testable import CoreKit

/// The hold's on/off contract over a scripted system volume. The private call that sets the real volume lives in
/// `MediaPlayerVolume`, which exists only on iOS and needs a device, so it is not covered here.
@MainActor
final class VolumeHoldTests: XCTestCase {

    // MARK: - Holding
    func testTheVolumeIsRaisedAsSoonAsTheHoldStarts() async {
        let volume = ScriptedVolume(level: 0.3)

        let task = start(VolumeHold(volume: volume))
        await Self.wait { volume.level == 1 }
        task.cancel()

        XCTAssertEqual(volume.raises, 1)
    }

    func testAVolumeAlreadyAtItsMaximumIsLeftAlone() async {
        let volume = ScriptedVolume(level: 1)

        let task = start(VolumeHold(volume: volume))
        await Self.wait { volume.isListening }
        task.cancel()

        XCTAssertEqual(volume.raises, 0)
    }

    func testTurningTheVolumeDownRaisesItAgainEachTime() async {
        let volume = ScriptedVolume(level: 1)
        let task = start(VolumeHold(volume: volume))
        await Self.wait { volume.isListening }

        for expected in 1...3 {
            volume.person(turnsTo: 0.2)
            await Self.wait { volume.raises == expected }
            XCTAssertEqual(volume.level, 1)
        }
        task.cancel()
    }

    // MARK: - Letting go
    func testCancellingTheHoldStopsListeningAndLeavesTheVolumeAlone() async {
        let volume = ScriptedVolume(level: 1)
        let task = start(VolumeHold(volume: volume))
        await Self.wait { volume.isListening }

        task.cancel()
        await Self.wait { !volume.isListening }
        volume.person(turnsTo: 0.2)
        await Task.yield()

        XCTAssertFalse(volume.isListening)
        XCTAssertEqual(volume.raises, 0)
        XCTAssertEqual(volume.level, 0.2)
    }

    // MARK: - The system's control is not there yet
    func testAMissingControlIsTriedAgainUntilItAppears() async {
        let volume = ScriptedVolume(level: 0.3, available: false)

        let task = start(VolumeHold(volume: volume, retryDelay: .milliseconds(5)))
        await Self.wait { volume.attempts >= 3 }
        XCTAssertEqual(volume.level, 0.3)
        volume.available = true
        await Self.wait { volume.level == 1 }
        let attempts = volume.attempts
        try? await Task.sleep(for: .milliseconds(50))
        task.cancel()

        XCTAssertEqual(volume.attempts, attempts, "it stops trying once the volume is up")
    }

    func testAControlThatNeverAppearsIsTriedAFewTimesAndThenLeftUntilTheNextChange() async {
        let volume = ScriptedVolume(level: 0.3, available: false)

        let task = start(VolumeHold(volume: volume, retryDelay: .milliseconds(1), attempts: 4))
        await Self.wait { volume.attempts == 4 }
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(volume.attempts, 4, "it does not poll for ever")

        volume.available = true
        volume.person(turnsTo: 0.2)
        await Self.wait { volume.level == 1 }
        task.cancel()
    }

    func testCancellingWhileAControlIsMissingEndsTheRetries() async {
        let volume = ScriptedVolume(level: 0.3, available: false)
        let task = start(VolumeHold(volume: volume, retryDelay: .seconds(60)))
        await Self.wait { volume.attempts == 1 }

        task.cancel()
        await task.value

        XCTAssertEqual(volume.attempts, 1)
    }
}

// MARK: - Helpers
private extension VolumeHoldTests {

    func start(_ hold: VolumeHold) -> Task<Void, Never> {
        Task { await hold.run() }
    }

    /// Lets the hold's task run until `condition` holds, or five seconds pass, which the assertions then report.
    static func wait(until condition: @MainActor () -> Bool) async {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition(), ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(2))
        }
    }
}

/// A system volume that moves only when told to, and counts what the hold asked of it.
@MainActor
private final class ScriptedVolume: SystemVolume {

    var level: Float
    var available: Bool
    private(set) var raises = 0
    private(set) var attempts = 0
    private(set) var isListening = false
    private var continuation: AsyncStream<Void>.Continuation?

    init(level: Float, available: Bool = true) {
        self.level = level
        self.available = available
    }

    func raiseToMaximum() -> Bool {
        attempts += 1
        guard available else { return false }
        raises += 1
        level = 1
        continuation?.yield()
        return true
    }

    func changes() -> AsyncStream<Void> {
        isListening = true
        return AsyncStream { continuation in
            self.continuation = continuation
            continuation.onTermination = { _ in
                Task { @MainActor in self.isListening = false }
            }
        }
    }

    /// The person turns the volume to `level` with the device's buttons.
    func person(turnsTo level: Float) {
        self.level = level
        continuation?.yield()
    }
}
