import CoreKit

/// How the Areas feature asks the app to show something. The app owns every stack and sheet.
@MainActor
public protocol AreasRouting: AnyObject {

    /// The tasks of the area: those due today, or every open one.
    func showTasks(areaId: String, todayOnly: Bool)

    /// The Podrobnosti of a task or an event of the area.
    func showDetails(kind: ItemKind, id: String)

    /// A collection of what is connected to the area.
    func showCollection(_ target: CollectionTarget)

    /// The mail of the area.
    func showMail(areaId: String)

    /// The notes of the area.
    func showNotes(areaId: String)
}

/// A router for previews: it opens nothing.
@MainActor
final class PreviewAreasRouter: AreasRouting {

    // MARK: - Protocol conformance
    func showTasks(areaId: String, todayOnly: Bool) {}

    func showDetails(kind: ItemKind, id: String) {}

    func showCollection(_ target: CollectionTarget) {}

    func showMail(areaId: String) {}

    func showNotes(areaId: String) {}
}
