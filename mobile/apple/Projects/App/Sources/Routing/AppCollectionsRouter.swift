import CollectionsFeature
import CoreKit

/// Routes of the Collections feature, on the stack of the tab it was created for. The screens of other features that
/// a collection or an item reaches (the tasks, mail, notes and agent of a project, the sheet of an event, an area) are
/// not built here: an event and an area open as the generic item until the app maps them to their own screens, and
/// the requests for the others are accepted and dropped until it does.
@MainActor
final class AppCollectionsRouter {

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
extension AppCollectionsRouter: CollectionsRouting {

    func showItem(itemId: String, databaseKey: String?) {
        context.push(.collectionItem(itemId: itemId, databaseKey: databaseKey), in: tab)
    }

    func showCollection(_ target: CollectionTarget) {
        context.push(.collection(target), in: tab)
    }

    func showEvent(itemId: String) {
        context.push(.collectionItem(itemId: itemId, databaseKey: "events"), in: tab)
    }

    func showArea(areaId: String) {
        context.push(.collectionItem(itemId: areaId, databaseKey: "areas"), in: tab)
    }

    func showProjectMail(projectId: String) {
        context.showMail(MailListStart(projectId: projectId), in: tab)
    }

    // The requests below belong to features that are built elsewhere; the integrator maps each to its screen.
    func showProjectTasks(projectId: String) {}
    func showProjectNotes(projectId: String) {}
    func showProjectAgent(projectId: String) {}
}
