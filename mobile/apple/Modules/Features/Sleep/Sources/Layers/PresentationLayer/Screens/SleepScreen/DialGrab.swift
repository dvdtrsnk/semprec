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
}
