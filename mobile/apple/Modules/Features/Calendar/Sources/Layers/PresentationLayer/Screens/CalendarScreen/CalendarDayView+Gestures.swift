import CoreKit
import DesignSystem
import SwiftUI

/// An item being carried about the day, by the system's drag or by a finger sliding on the selected item.
struct CalendarCarry {

    let item: CalendarItem
    /// Where the finger was when the item lifted, in the day view's coordinates; where it is now is `carryLocation`.
    let start: CGPoint
    /// How many minutes below the top of the item the finger took hold of it, in minutes of the day: the day may
    /// scroll under the finger, and the place it touched goes with the day, not with the screen.
    var grab: Int
    /// Set once the finger travelled far enough for the item to be moved rather than only held.
    var moved: Bool
    /// Whether the system's drag carries it, which other fingers and other apps share; otherwise a finger slides it.
    let isSystemDrag: Bool
    /// Where the timeline's content was when the finger took hold.
    var startTop: CGFloat
}

// MARK: - Gestures
extension CalendarDayView {

    func handlers(day key: String) -> CalendarItemHandlers {
        CalendarItemHandlers(
            tap: { item in
                if let until = tapsHeldBackUntil, Date() < until { return }
                viewModel.gesture(.tap(itemId: item.id))
            },
            hold: { viewModel.gesture(.select(itemId: $0.id)) },
            slide: { item, value in slide(item, value) },
            slideEnd: { letGo() },
            transfer: { CalendarItemTransfer($0, timezone: state.timezone) },
            dragEnded: {
                tapsHeldBackUntil = Date().addingTimeInterval(Self.tapHoldBack)
                dropQueue.push(CalendarDropEvent(kind: .ended, location: nil))
            },
            toggle: { viewModel.gesture(.toggleDone(itemId: $0, inEventId: $1)) },
            openTask: { viewModel.gesture(.tap(itemId: $0)) }
        )
    }

    var sleepHandlers: CalendarSleepHandlers {
        CalendarSleepHandlers(
            open: { night in
                if selectedNight == night {
                    selectedNight = nil
                } else {
                    viewModel.open(.sleep(night: night))
                }
            },
            hold: { night in
                selectedNight = night
                nightHold = CalendarNightHold(night: night, startY: nil)
                viewModel.gesture(.tapBackground)
            },
            drag: { night, edge, delta in
                selectedNight = night
                viewModel.gesture(.sleepDrag(night: night, edge: edge, deltaMinutes: delta))
            },
            dragEnd: { viewModel.gesture(.endSleepDrag(commit: true)) }
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

    /// Where the finger carrying an item is now. It is kept outside the view's state, as is where the carried block
    /// follows it to (`dragFollower`): they change on every frame of a drag, and only the block moves with them.
    var carryLocation: CGPoint { frames.carryLocation ?? carry?.start ?? .zero }

    /// Reports the carried item's place from the finger's last place: also when the day moved under a finger that
    /// did not, scrolled or turned. The shared layer is told only when the place it would snap to is another.
    func sendMove() {
        guard let carry, carry.moved else { return }
        let location = carryLocation
        // Over the week the item is no longer on the day: it goes back to its place until the finger comes back.
        if location.y < allDayZoneTop {
            frames.sentMove = nil
            if state.drag != nil {
                viewModel.gesture(.endDrag(commit: false))
                viewModel.gesture(.tapBackground)
            }
            return
        }
        let rawStart = minutes(at: location.y) - carry.grab
        let move = CalendarSentMove(
            day: shownDay,
            quarter: Int((Double(rawStart) / 15).rounded()),
            overAllDayRow: location.y < headerHeight,
            overEventId: carry.item.isTask ? eventId(at: location, excluding: carry.item.id) : nil
        )
        guard move != frames.sentMove else { return }
        frames.sentMove = move
        viewModel.gesture(.dragMove(
            itemId: carry.item.id,
            day: move.day,
            rawStart: rawStart,
            overAllDayRow: move.overAllDayRow,
            overEventId: move.overEventId
        ))
    }

    /// Moves the carried item's finger to `location`: past the first few points it starts to move the item, and at a
    /// side of the screen it turns the day. The block follows the finger at once; the shared layer is told of the
    /// place when it is another quarter hour, day, row or event.
    func moveCarry(to location: CGPoint) {
        guard let current = carry else { return }
        frames.carryLocation = location
        // The finger moves the item when it travels on the screen, or when the day scrolls under it, by itself at an
        // edge or under another finger.
        let travel = hypot(
            location.x - current.start.x,
            location.y - current.start.y + frames.content.minY - current.startTop
        )
        if !current.moved, travel >= Self.moveThreshold {
            var next = current
            next.moved = true
            carry = next
        }
        guard carry?.moved == true else { return }
        let grab = current.grab
        let free = min(max(minutes(at: location.y) - grab, 0), CalendarGeometry.minutesPerDay)
        if dragFollower.freeStart != free { dragFollower.freeStart = free }
        sendMove()
        restEdge(edge(ofFingerAt: location.x))
    }

    /// Lets go of the carried item: the block goes to the place the shared layer snapped it to, or back to its own.
    func releaseCarry() {
        carry = nil
        frames.carryLocation = nil
        frames.sentMove = nil
        dragFollower.freeStart = nil
    }

    /// Takes hold of `item` under a finger at `location`.
    func takeHold(of item: CalendarItem, at location: CGPoint, isSystemDrag: Bool) -> CalendarCarry {
        CalendarCarry(
            item: item,
            start: location,
            grab: grab(of: item, at: location),
            moved: false,
            isSystemDrag: isSystemDrag,
            startTop: frames.content.minY
        )
    }

    /// How many minutes below the top of `item` a finger at `location` holds it: where it is on the item's block, or,
    /// when the finger already left the block before the drag reached the day, in the middle of the item. An item
    /// without a time is held at its top.
    func grab(of item: CalendarItem, at location: CGPoint) -> Int {
        guard let start = item.startMinutes else { return 0 }
        if let frame = itemFrames[item.id], !frame.contains(location) {
            return ((item.endMinutes ?? start) - start) / 2
        }
        return minutes(at: location.y) - start
    }

    /// How far a finger has to travel before a held item is moved rather than only held.
    static var moveThreshold: CGFloat { 4 }
}

// MARK: - Sliding a selected item
extension CalendarDayView {

    /// A finger slides on the selected item: it follows at once, and the day scrolls under it at the top and bottom.
    func slide(_ item: CalendarItem, _ value: DragGesture.Value) {
        if carry?.item.id != item.id {
            carry = takeHold(of: item, at: value.startLocation, isSystemDrag: false)
        }
        moveCarry(to: value.location)
        autoScrollSpeed = scrollSpeed(forFingerAt: value.location.y)
    }

    /// The sliding finger lifted: the item is dropped where it is, or only let go of when it was not moved.
    func letGo() {
        guard let carry, !carry.isSystemDrag else { return }
        autoScrollSpeed = 0
        restEdge(0)
        releaseCarry()
        if carry.moved { viewModel.gesture(.endDrag(commit: true)) }
    }

    /// How fast the day scrolls under a sliding finger, in points a second (down is positive): not at all in the
    /// middle, and faster the closer the finger comes to the header or to the bars at the bottom. The system's drag
    /// scrolls the day by itself.
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

    /// The fastest the day scrolls under a sliding finger.
    static var fastestScroll: CGFloat { 520 }
}

// MARK: - Turning the day
extension CalendarDayView {

    /// Which side edge a finger at `fingerX` is at, if it is within a thumb's width of one.
    func edge(ofFingerAt fingerX: CGFloat) -> Int {
        if fingerX < Self.sideZone { return -1 }
        if dayWidth > 0, fingerX > dayWidth - Self.sideZone { return 1 }
        return 0
    }

    /// Turns to the next or the previous day under the carried item, as the system Calendar does when an item is
    /// carried against a side of the screen and left there a moment.
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

    /// How long a carried item rests at a side edge before the day turns, and again before it turns once more.
    static var turnPause: Int { 750 }

    /// How far from a side of the screen the finger has to be for the day to turn.
    static var sideZone: CGFloat { 28 }
}

/// A night held by a finger; `startY` is where a move began when it is not where the finger touched.
struct CalendarNightHold: Equatable {

    let night: String
    var startY: CGFloat?
}

// MARK: - Moving a held night
extension CalendarDayView {

    /// The finger on the day moved: a night it holds follows it, by the minutes it travelled since the hold.
    func followNight(_ value: DragGesture.Value) {
        guard let hold = nightHold else { return }
        let startY = hold.startY ?? value.startLocation.y
        let delta = Int(((value.location.y - startY) / CGFloat(hourHeight) * 60).rounded())
        viewModel.gesture(.sleepDrag(night: hold.night, edge: nil, deltaMinutes: delta))
    }

    /// The finger lifted: a night it moved is written, and one it only held stays selected.
    func letGoOfNight() {
        guard nightHold != nil else { return }
        nightHold = nil
        if state.sleepDrag != nil { viewModel.gesture(.endSleepDrag(commit: true)) }
    }
}
