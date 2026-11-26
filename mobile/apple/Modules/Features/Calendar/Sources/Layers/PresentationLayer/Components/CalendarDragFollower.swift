import SwiftUI

/// Where the held block follows the finger to, in minutes of the day and not snapped. It changes on every frame of a
/// drag, so only the block reads it: the day around it is drawn again only when the snapped place changes.
@MainActor
@Observable
final class CalendarDragFollower {

    var freeStart: Int?
}

/// Moves a block from the place it is laid out at to the one its follower names, while it is held.
struct CalendarFollowedBlock: ViewModifier {

    let follower: CalendarDragFollower?
    let start: Int
    let geometry: CalendarGeometry

    func body(content: Content) -> some View {
        let shift = follower?.freeStart.map { geometry.y(minutes: $0) - geometry.y(minutes: start) } ?? 0
        content.offset(y: shift)
    }
}

/// What the system's drag did over the day, queued as it comes; only `CalendarDropPump` follows the queue, so a report
/// draws nothing else again.
@MainActor
@Observable
final class CalendarDropQueue {

    private(set) var version = 0
    @ObservationIgnored private var events: [CalendarDropEvent] = []

    func push(_ event: CalendarDropEvent) {
        events.append(event)
        version += 1
    }

    /// The events since the last drain, in order.
    func drain() -> [CalendarDropEvent] {
        defer { events.removeAll() }
        return events
    }
}

/// Hands the queued reports of the system's drag to the day view, in the view's current state, once per update.
struct CalendarDropPump: View {

    let queue: CalendarDropQueue
    let handle: ([CalendarDropEvent]) -> Void

    var body: some View {
        Color.clear
            .allowsHitTesting(false)
            .onChange(of: queue.version) { handle(queue.drain()) }
    }
}
