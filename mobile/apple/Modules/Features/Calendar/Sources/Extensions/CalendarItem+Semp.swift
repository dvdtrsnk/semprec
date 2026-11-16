import CoreKit
import DesignSystem
import SwiftUI

// MARK: - Semp
extension CalendarItem {

    /// What the Semp bubble receives when it is dropped on the item, or nil for what is not an object of its own
    /// (holidays, birthdays, sleep and the traces of carried-over tasks). `meta` is the line under the title.
    func sempTarget(meta: String?) -> SempTarget? {
        switch kind {
        case .task: SempTarget(kind: .task, title: title, meta: meta, itemId: id)
        case .event: SempTarget(kind: .event, title: title, meta: meta, itemId: id)
        case .birthday, .holiday, .sleep, .trace: nil
        }
    }
}

// MARK: - Drop target
extension View {

    /// Makes the view an object the Semp bubble can be dropped on, if `item` is one.
    @ViewBuilder
    func sempTarget(of item: CalendarItem, meta: String?) -> some View {
        if let target = item.sempTarget(meta: meta) {
            dropTarget(target)
        } else {
            self
        }
    }
}
