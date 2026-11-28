import Foundation
import SwiftUI

/// The day view as the target of a drag of a calendar item: the system reports every place the finger passes,
/// many times a second even while it rests, and the drop. Only drags of Alldots's own items are taken; what a drag
/// carries can be read only at its drop.
struct CalendarDayDrop: DropDelegate {

    // MARK: - Dependencies
    let onEnter: (_ location: CGPoint) -> Void
    let onMove: (_ location: CGPoint) -> DropProposal
    let onExit: () -> Void
    let onDrop: (_ location: CGPoint, _ providers: [NSItemProvider]) -> Bool

    // MARK: - DropDelegate
    func validateDrop(info: DropInfo) -> Bool {
        info.hasItemsConforming(to: [.init(exportedAs: CalendarItemTransfer.typeIdentifier)])
    }

    func dropEntered(info: DropInfo) {
        onEnter(info.location)
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        onMove(info.location)
    }

    func dropExited(info: DropInfo) {
        onExit()
    }

    func performDrop(info: DropInfo) -> Bool {
        onDrop(info.location, info.itemProviders(for: [.init(exportedAs: CalendarItemTransfer.typeIdentifier)]))
    }
}
