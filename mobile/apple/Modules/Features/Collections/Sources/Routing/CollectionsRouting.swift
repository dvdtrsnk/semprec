import CoreKit
import Foundation

/// Navigation the Collections feature requests. The app implements it on its own navigation stacks.
///
/// The screens of the other features that a collection or an item reaches (the tasks, the mail, the notes and the
/// agent of a project, the sheet of an event, an area) are not built here: the app maps these requests to them.
@MainActor
public protocol CollectionsRouting: AnyObject {

    // MARK: - Collections and items
    /// Opens the detail of an item of any database, except an event, which has its own sheet.
    func showItem(itemId: String, databaseKey: String?)
    /// Opens a collection, such as the files of a project or a related collection of an item.
    func showCollection(_ target: CollectionTarget)

    // MARK: - Screens of other features
    /// The shared "Podrobnosti" sheet of an event.
    func showEvent(itemId: String)
    func showArea(areaId: String)
    func showProjectTasks(projectId: String)
    func showProjectMail(projectId: String)
    func showProjectNotes(projectId: String)
    func showProjectAgent(projectId: String)
}

// MARK: - Preview router
@MainActor
final class PreviewCollectionsRouter: CollectionsRouting {

    // MARK: - Methods
    func showItem(itemId: String, databaseKey: String?) {}
    func showCollection(_ target: CollectionTarget) {}
    func showEvent(itemId: String) {}
    func showArea(areaId: String) {}
    func showProjectTasks(projectId: String) {}
    func showProjectMail(projectId: String) {}
    func showProjectNotes(projectId: String) {}
    func showProjectAgent(projectId: String) {}
}
