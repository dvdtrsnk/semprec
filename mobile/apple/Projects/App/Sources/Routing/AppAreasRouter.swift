import AreasFeature
import CoreKit
import Foundation

/// Routes of the Areas feature, on the stack of the tab the area screen was created for. The area's tasks and the
/// Podrobnosti of a task or an event are the screens the Tasks feature builds, a collection is the engine of the
/// Collections feature; the mail of an area belongs to a feature that is built elsewhere, so its row opens a notice
/// until it is; its notes are the page of the area.
@MainActor
final class AppAreasRouter {

    // MARK: - Dependencies
    private let context: NavigationContext
    private let tab: AppTab

    // MARK: - Init
    init(context: NavigationContext, tab: AppTab) {
        self.context = context
        self.tab = tab
    }
}

// MARK: - Protocol conformance
extension AppAreasRouter: AreasRouting {

    func showTasks(areaId: String, todayOnly: Bool) {
        let start = TasksStart(tab: todayOnly ? .today : .all, hideDone: !todayOnly, areaId: areaId)
        context.showTasks(start, in: tab)
    }

    func showDetails(kind: ItemKind, id: String) {
        context.showDetails(kind: kind, id: id, from: tab)
    }

    func showCollection(_ target: CollectionTarget) {
        context.push(.collection(target), in: tab)
    }

    func showMail(areaId: String) {
        context.push(.pending(title: String(localized: "pending.mail")), in: tab)
    }

    func showNotes(areaId: String) {
        context.push(.notes(itemId: areaId, tab: tab), in: tab)
    }
}
