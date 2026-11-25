import CoreKit
import DesignSystem
import SwiftUI

/// An item a finger holds, and the day it was taken from.
struct Hold {

    let item: CalendarItem
    let day: String
}

/// An item held by a finger.
struct HeldDrag {

    let item: CalendarItem
    let day: String
    let location: CGPoint
    /// How many minutes below the top of the item the finger took hold of it.
    let grab: Int
}

// MARK: - Gestures
extension CalendarDayView {

    func handlers(day key: String) -> CalendarItemHandlers {
        CalendarItemHandlers(
            tap: { viewModel.gesture(.tap(itemId: $0.id)) },
            hold: { item in
                viewModel.gesture(.select(itemId: item.id))
                hold = Hold(item: item, day: key)
            },
            toggle: { viewModel.gesture(.toggleDone(itemId: $0)) },
            openTask: { viewModel.gesture(.tap(itemId: $0)) }
        )
    }

    func menu(_ action: CalendarEditAction, _ item: CalendarItem) {
        switch action {
        case .cut: viewModel.edit(.cut(itemId: item.id))
        case .copy: viewModel.edit(.copy(itemId: item.id))
        case .duplicate: viewModel.edit(.duplicate(itemId: item.id))
        case .delete: viewModel.edit(.delete(itemId: item.id))
        }
    }

    /// The minutes of the day at a vertical place of the day view; not snapped, the shared layer does that.
    func minutes(at position: CGFloat) -> Int {
        Int(((position - frames.content.minY) / CGFloat(hourHeight) * 60).rounded())
    }

    func eventId(at location: CGPoint, excluding id: String) -> String? {
        eventFrames.first { $0.key != id && $0.value.contains(location) }?.key
    }

    /// The hour a day opens at: two hours before now on today, seven in the morning otherwise.
    func startHour(day key: String) -> Int {
        key == state.today ? max(state.nowMinutes / 60 - 2, 0) : 7
    }

    /// Reports the held item's place again from the finger's last place: the day moved under a finger that did not.
    func sendMove() {
        guard let held = drag else { return }
        viewModel.gesture(.dragMove(
            itemId: held.item.id,
            day: shownDay,
            rawStart: minutes(at: held.location.y) - held.grab,
            overAllDayRow: held.location.y < headerHeight,
            overEventId: held.item.isTask ? eventId(at: held.location, excluding: held.item.id) : nil
        ))
    }

    /// The minute the held block starts at when it follows the finger exactly.
    var freeStart: Int? {
        guard let held = drag else { return nil }
        _ = followTicks
        return min(max(minutes(at: held.location.y) - held.grab, 0), 24 * 60)
    }

    /// How fast the day scrolls, in points a second (down is positive), for a finger holding an item at `fingerY`: not
    /// at all in the middle, and faster the closer the finger comes to the header or to the bars at the bottom, as the
    /// system Calendar does.
    func scrollSpeed(forFingerAt fingerY: CGFloat) -> CGFloat {
        let zone: CGFloat = 110
        let top = headerHeight
        let bottom = frames.viewport.maxY
        guard bottom > top + 2 * zone else { return 0 }
        if fingerY < top { return 0 }
        if fingerY < top + zone { return -Self.fastestScroll * pow(1 - (fingerY - top) / zone, 1.5) }
        if fingerY > bottom - zone {
            return Self.fastestScroll * pow(min((fingerY - (bottom - zone)) / zone, 1), 1.5)
        }
        return 0
    }

    /// The held item follows the finger: moves to where it is, and scrolls or turns the day when it is at an edge.
    func follow(_ value: DragGesture.Value) {
        guard let held = hold else { return }
        let travelled = hypot(value.location.x - value.startLocation.x, value.location.y - value.startLocation.y)
        guard drag != nil || travelled >= Self.moveThreshold else { return }
        // Where the finger took hold of the item is worked out once, in minutes of the day: the day may scroll under
        // the finger afterwards, and the place it first touched goes with the day, not with the screen.
        let grab = drag?.item.id == held.item.id
            ? drag?.grab : held.item.startMinutes.map { minutes(at: value.startLocation.y) - $0 }
        drag = HeldDrag(item: held.item, day: held.day, location: value.location, grab: grab ?? 15)
        sendMove()
        autoScrollSpeed = scrollSpeed(forFingerAt: value.location.y)
        restEdge(edge(ofFingerAt: value.location.x))
    }

    /// The finger lifted: the held item is dropped where it is, or only let go of when it was not moved.
    func letGo() {
        guard hold != nil else { return }
        let moved = drag != nil
        autoScrollSpeed = 0
        restEdge(0)
        drag = nil
        hold = nil
        if moved { viewModel.gesture(.endDrag(commit: true)) }
    }

    /// How far a finger has to travel before a held item is moved rather than only held.
    static var moveThreshold: CGFloat { 4 }

    /// Which side edge a finger at `fingerX` is at, if it is within a thumb's width of one.
    func edge(ofFingerAt fingerX: CGFloat) -> Int {
        if fingerX < Self.sideZone { return -1 }
        if dayWidth > 0, fingerX > dayWidth - Self.sideZone { return 1 }
        return 0
    }

    /// Turns to the next or the previous day under the held item, as the system Calendar does when an item is carried
    /// against a side of the screen and left there a moment.
    func turnDay(_ steps: Int) {
        let day = CalendarDates.shifted(shownDay, by: steps)
        tick(for: day)
        chosenDay = day
        viewModel.navigate(.page(steps: steps))
    }

    /// The finger is at `edge` (or at none, 0). A new edge starts a clock that counts the moments the item rests there,
    /// each of which turns a day; leaving the edge stops it.
    func restEdge(_ edge: Int) {
        guard edge != sideEdge else { return }
        sideEdge = edge
        edgeClock?.cancel()
        guard edge != 0 else { return }
        edgeClock = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(Self.turnPause))
                guard !Task.isCancelled else { return }
                edgeMoments += 1
            }
        }
    }

    /// How long a held item rests at a side edge before the day turns, and again before it turns once more.
    static var turnPause: Int { 750 }

    /// How far from a side of the screen the finger has to be for the day to turn.
    static var sideZone: CGFloat { 28 }

    /// The fastest the day scrolls under a held item, which is 6 hours a second at the default hour height.
    static var fastestScroll: CGFloat { 520 }
}
