import CollectionsFeature
import CoreKit

/// Routes of the Collections feature, on the stack of the tab it was created for. An item opens the way
/// `NavigationContext.showItem` says for its database. The router of an item shown in a sheet (`closesSheet`) first
/// dismisses that sheet, so that what the item opens appears on the stack under it.
@MainActor
final class AppCollectionsRouter {

    // MARK: - Dependencies
    private let context: NavigationContext
    private let tab: AppTab
    private let closesSheet: Bool

    // MARK: - Init
    init(context: NavigationContext, tab: AppTab, closesSheet: Bool = false) {
        self.context = context
        self.tab = tab
        self.closesSheet = closesSheet
    }
}

// MARK: - Protocol conformance
extension AppCollectionsRouter: CollectionsRouting {

    func showItem(itemId: String, databaseKey: String?) {
        leaveSheet()
        context.showItem(itemId: itemId, databaseKey: databaseKey, from: tab)
    }

    func showCollection(_ target: CollectionTarget) {
        leaveSheet()
        context.push(.collection(target), in: tab)
    }

    func showEvent(itemId: String) {
        leaveSheet()
        context.showItem(itemId: itemId, databaseKey: "events", from: tab)
    }

    func showProjectMail(projectId: String) {
        leaveSheet()
        context.showMail(MailListStart(projectId: projectId), in: tab)
    }

    func showProjectMailSignals(projectId: String) {
        leaveSheet()
        context.push(.projectMailSignals(projectId: projectId), in: tab)
    }

    func showProjectTasks(projectId: String) {
        leaveSheet()
        context.showTasks(TasksStart(tab: .all, projectId: projectId), in: tab)
    }

    func showProjectNotes(projectId: String) {
        leaveSheet()
        context.push(.notes(itemId: projectId, tab: tab), in: tab)
    }

    func showProjectAgent(projectId: String) {
        leaveSheet()
        context.push(.sempProjectAgent(projectId: projectId), in: tab)
    }
}

// MARK: - Private
private extension AppCollectionsRouter {

    func leaveSheet() {
        if closesSheet { context.dismissSheets(in: tab) }
    }
}
