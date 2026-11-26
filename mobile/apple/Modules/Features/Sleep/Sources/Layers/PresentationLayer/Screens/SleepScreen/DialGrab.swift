import CoreKit
import Foundation

/// What a finger holds on the dial while a drag lasts: which part of the snake, how far the finger was from that
/// part's time when the drag began (so the part does not jump under the finger), and the last step that was sent to
/// the shared draft. It lives only for the gesture; the times themselves are the shared draft's.
struct DialGrab: Equatable {

    let handle: SleepDialHandle
    let offsetMinutes: Double
    var lastSentStep: Int?

    /// The part of the snake under `point`, or nil when the finger is off the track or off the snake.
    static func start(at point: CGPoint, geometry: DialGeometry, draft: SleepDraft) -> DialGrab? {
        guard geometry.isOnTrack(point) else { return nil }
        let finger = geometry.minutes(at: point)
        let bed = Double(draft.bedMinutes)
        let wake = Double(draft.wakeMinutes)
        let reach = geometry.knobInsetMinutes * 1.6
        let toBed = abs(DialGeometry.signedDistance(from: finger, to: bed))
        let toWake = abs(DialGeometry.signedDistance(from: finger, to: wake))
        if toBed <= reach || toWake <= reach {
            return toBed <= toWake
                ? DialGrab(handle: .bed, offsetMinutes: DialGeometry.signedDistance(from: finger, to: bed))
                : DialGrab(handle: .wake, offsetMinutes: DialGeometry.signedDistance(from: finger, to: wake))
        }
        let along = DialGeometry.wrapped(finger - bed)
        guard along <= Double(draft.durationMinutes) else { return nil }
        return DialGrab(handle: .whole, offsetMinutes: DialGeometry.signedDistance(from: finger, to: bed))
    }

    /// The time the held part is dragged to when the finger is at `point`, in minutes after midnight.
    func target(at point: CGPoint, geometry: DialGeometry) -> Int {
        Int((geometry.minutes(at: point) + offsetMinutes).rounded())
    }

    /// The time to send for the finger's `target` when it reached another step than the last one sent, nil while it
    /// is still on that step. The shared draft snaps the time; this only keeps the stream of sends to one per step.
    mutating func move(to target: Int, stepMinutes: Int) -> Int? {
        let step = Int((Double(target) / Double(max(stepMinutes, 1))).rounded())
        guard step != lastSentStep else { return nil }
        lastSentStep = step
        return target
    }
}

// MARK: - Accessibility
/// What the dial's accessibility controls send: an end moves by one step of the dial, and the night is written when
/// the screen writes each change.
struct SleepDialActions {

    // MARK: - Dependencies
    let send: (SleepAction) -> Void
    let onEnd: () -> Void

    // MARK: - Methods
    /// Moves `handle`, now at `minutes`, one `stepMinutes` later (`isLater`) or earlier; the shared draft wraps it.
    func adjust(_ handle: SleepDialHandle, at minutes: Int, stepMinutes: Int, isLater: Bool) {
        send(.draft(.moveDial(handle, minutes: isLater ? minutes + stepMinutes : minutes - stepMinutes)))
        onEnd()
    }
}
