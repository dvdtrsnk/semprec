import CoreKit
import Foundation
import SwiftUI

// MARK: - The system's drag
extension CalendarDayView {

    /// The drop target of the day view: the whole calendar under the navigation bar, the header with the all-day row
    /// included. The system keeps the first target it was given, so its closures only queue what happened, and the
    /// view handles it in its current state; they read nothing but the view's own state, which stays current.
    var dropTarget: CalendarDayDrop {
        CalendarDayDrop(
            onEnter: { location in
                tapsHeldBackUntil = .distantFuture
                dropQueue.push(CalendarDropEvent(kind: .entered, location: location))
            },
            onMove: { location in
                // The system reports the finger many times a second, also while it rests; the view is redrawn only when
                // the finger or the day under it moved.
                let top = frames.content.minY
                if location != frames.reportedLocation || top != frames.dropContentTop {
                    frames.reportedLocation = location
                    frames.dropContentTop = top
                    dropQueue.push(CalendarDropEvent(kind: .moved, location: location))
                }
                // Over the week the item leaves the day: nothing takes it there.
                if location.y < allDayZoneTop { return DropProposal(operation: .cancel) }
                return DropProposal(operation: carry?.item.editable == false ? .forbidden : .move)
            },
            onExit: {
                tapsHeldBackUntil = Date().addingTimeInterval(Self.tapHoldBack)
                dropQueue.push(CalendarDropEvent(kind: .exited, location: nil))
            },
            onDrop: { location, providers in
                tapsHeldBackUntil = Date().addingTimeInterval(Self.tapHoldBack)
                guard location.y >= allDayZoneTop else {
                    dropQueue.push(CalendarDropEvent(kind: .exited, location: nil))
                    return false
                }
                guard let carry else { return dropFromElsewhere(at: location, providers: providers) }
                dropQueue.push(CalendarDropEvent(kind: .dropped, location: location))
                return carry.moved && carry.item.editable
            }
        )
    }

    /// How long after a drag ends a tap on an item is no tap.
    static var tapHoldBack: TimeInterval { 0.4 }

    /// Handles what the system's drag did over the day since the view last looked, in order.
    func handleDropEvents(_ events: [CalendarDropEvent]) {
        guard !events.isEmpty else { return }
        for event in events {
            switch event.kind {
            case .entered: dragEntered(at: event.location ?? .zero)
            case .moved: dragMoved(to: event.location ?? .zero)
            case .exited: dragExited()
            case .dropped: dropped(at: event.location ?? .zero)
            case .ended: dragEnded()
            }
        }
    }

    /// A drag of an item came over the day: one that lifts from it, which the item reports as it lifts where the
    /// system tells, and which is otherwise the item under the finger; or one that left and comes back. The contents
    /// of a drag are read only at its drop, so a drag from another window is known only then.
    func dragEntered(at location: CGPoint) {
        frames.dropLocation = location
        if let lifted, Date().timeIntervalSince(lifted.time) < Self.liftWindow {
            self.lifted = nil
            carryDragged(lifted.itemId, liftedAt: lifted.location)
        } else if let reentry {
            carryDragged(reentry.itemId)
        } else if let itemId = itemId(at: location) {
            carryDragged(itemId)
        }
    }

    /// The item drawn at `location`: of overlapping blocks, the one that starts later, which lies over the other.
    func itemId(at location: CGPoint) -> String? {
        itemFrames.filter { $0.value.contains(location) }.max { $0.value.minY < $1.value.minY }?.key
    }

    /// How long after an item reports its lift the drag can still be taken as the one that lifted it, in seconds.
    static var liftWindow: TimeInterval { 2 }

    /// An item lifts into a drag under a finger at `location`: it is held, selected with its menu, and the drag that
    /// comes over the day carries it with the finger where it took hold.
    func noteLift(of item: CalendarItem, at location: CGPoint?) {
        lifted = CalendarLift(itemId: item.id, time: Date(), location: location)
        tapsHeldBackUntil = .distantFuture
        viewModel.gesture(.select(itemId: item.id))
    }

    /// Takes hold of the item a drag over the day carries. An item that lifts here is selected, as a held item is; one
    /// that comes back after it left the day is carried on, as it was taken.
    func carryDragged(_ itemId: String, liftedAt lift: CGPoint? = nil) {
        guard let location = frames.dropLocation, carry?.item.id != itemId,
            let item = state.days.lazy.flatMap(\.items).first(where: { $0.id == itemId }) else { return }
        if let reentry, reentry.itemId == itemId {
            carry = CalendarCarry(
                item: item, start: location, grab: reentry.grab, moved: true,
                isSystemDrag: true, startTop: frames.content.minY
            )
            moveCarry(to: location)
            return
        }
        var taken = takeHold(of: item, at: location, isSystemDrag: true)
        // The finger holds the item where it lifted it, which may lie a little before where the drag reached the day.
        if let lift { taken.grab = grab(of: item, at: lift) }
        carry = taken
        if item.editable, state.selectedItemId != itemId { viewModel.gesture(.select(itemId: itemId)) }
    }

    /// The finger of a drag is at `location`: the carried item follows it.
    func dragMoved(to location: CGPoint) {
        frames.dropLocation = location
        moveCarry(to: location)
    }

    /// The drag left the day, for another part of the screen or another app, or it ended without a drop. A moved item
    /// goes back to its place and is let go of, to be carried on should the drag come back; an item lifted and let go
    /// where it lay stays held, with its menu, as after a long press.
    func dragExited() {
        frames.dropLocation = nil
        restEdge(0)
        guard let carry else { return }
        releaseCarry()
        guard carry.moved else { return }
        reentry = CalendarReentry(itemId: carry.item.id, grab: carry.grab)
        viewModel.gesture(.endDrag(commit: false))
        viewModel.gesture(.tapBackground)
    }

    /// The drag was dropped on the day at `location`: the item moves there.
    func dropped(at location: CGPoint) {
        frames.dropLocation = nil
        restEdge(0)
        reentry = nil
        guard let carry else { return }
        guard carry.moved, carry.item.editable else {
            releaseCarry()
            return
        }
        moveCarry(to: location)
        releaseCarry()
        viewModel.gesture(.endDrag(commit: true))
    }

    /// Reads the item a drag from another window carries and moves it to where it was dropped, its top at the finger.
    func dropFromElsewhere(at location: CGPoint, providers: [NSItemProvider]) -> Bool {
        guard let provider = providers.first else { return false }
        _ = provider.loadTransferable(type: CalendarItemTransfer.self) { result in
            guard case .success(let transfer) = result else { return }
            Task { @MainActor in droppedItem = CalendarDroppedItem(id: transfer.id, location: location) }
        }
        return true
    }

    /// Moves an item dropped from another window, once read, to the day and the time under the finger.
    func placeDropped(_ dropped: CalendarDroppedItem) {
        guard let item = state.days.lazy.flatMap(\.items).first(where: { $0.id == dropped.id }), item.editable else {
            return
        }
        carry = CalendarCarry(
            item: item, start: dropped.location, grab: 0, moved: true,
            isSystemDrag: true, startTop: frames.content.minY
        )
        frames.carryLocation = dropped.location
        sendMove()
        releaseCarry()
        viewModel.gesture(.endDrag(commit: true))
    }

    /// The system's drag of an item ended, wherever it was dropped: one carried back later is a new drag, and one
    /// still carried was let go of where nothing takes it, as over the week, and goes back to its place.
    func dragEnded() {
        reentry = nil
        if carry?.isSystemDrag == true { dragExited() }
        reentry = nil
    }
}

/// Something the system's drag did over the day, queued for the view to handle in its current state.
struct CalendarDropEvent: Equatable {

    enum Kind {
        case entered
        case moved
        case exited
        case dropped
        case ended
    }

    let kind: Kind
    let location: CGPoint?
    /// Tells two events of the same kind at the same place apart.
    let event = UUID()
}

/// An item that lifted into a drag, and when.
struct CalendarLift {

    let itemId: String
    let time: Date
    /// Where the finger lifted it, when the drag says.
    let location: CGPoint?
}

/// An item dropped on the day from another window, and where.
struct CalendarDroppedItem: Equatable {

    let id: String
    let location: CGPoint
    /// Tells two drops of the same item at the same place apart, so each is taken.
    let drop = UUID()
}

/// The item a drag carried out of the day, and where the finger held it, for when it comes back.
struct CalendarReentry {

    let itemId: String
    let grab: Int
}

#if os(iOS)
// MARK: - Drag source
extension CalendarDayView {

    /// What the drag source of the day's items asks of the day view.
    var dragSourceModel: CalendarDragSourceModel {
        CalendarDragSourceModel(
            item: { location in
                guard state.drag == nil, let id = itemId(at: location),
                    let item = dayState(shownDay).items.first(where: { $0.id == id }) ?? heldItemOnDay(id),
                    item.kind == .event || item.kind == .task else { return nil }
                return item
            },
            frame: { itemFrames[$0] },
            transfer: { CalendarItemTransfer($0, timezone: state.timezone) },
            isOverDay: { location in
                location.y >= allDayZoneTop && location.y <= frames.viewport.maxY && location.x >= 0
                    && location.x <= dayWidth
            },
            lifted: { item, location in noteLift(of: item, at: location) },
            ended: {
                tapsHeldBackUntil = Date().addingTimeInterval(Self.tapHoldBack)
                dropQueue.push(CalendarDropEvent(kind: .ended, location: nil))
            }
        )
    }

    /// An item of the shown day that is drawn in its header rather than among its timed items.
    func heldItemOnDay(_ id: String) -> CalendarItem? {
        allDayItems(shownDay).first { $0.id == id }
    }
}
#endif
