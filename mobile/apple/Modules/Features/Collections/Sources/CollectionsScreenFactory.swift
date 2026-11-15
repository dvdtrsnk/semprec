import CoreKit
import SwiftUI

/// The screens of the Collections feature. A screen calls `makeModel` once, when SwiftUI creates its `@StateObject`,
/// and owns that model for as long as SwiftUI keeps the screen.
///
/// There is one collection screen and one item screen. The concrete screens of the design are those two over
/// different data: `projects`, `people`, `companies`, `events` and `files` name the collection of each database,
/// narrowed to an area or to the item it hangs on; `item` shows any item, with the layout of a project for a project.
@MainActor
public enum CollectionsScreenFactory {

    // MARK: - Collections
    /// The collection of any target; the screen of Projects, People, Companies, Events and Files is this one.
    public static func collection(
        _ target: CollectionTarget,
        makeModel: @escaping @MainActor (CollectionTarget) -> any CollectionScreenModel,
        router: any CollectionsRouting
    ) -> some View {
        CollectionScreen(viewModel: CollectionViewModel(model: makeModel(target), router: router))
    }

    /// The collection of the projects, of every area or of one (Family, Health, Home and Work projects).
    public static func projects(areaId: String? = nil) -> CollectionTarget {
        areaTarget(DatabaseKey.projects, areaId: areaId)
    }

    public static func people() -> CollectionTarget {
        .whole(databaseKey: DatabaseKey.people, databaseId: nil)
    }

    /// The collection of the companies, of every area or of one (Work companies).
    public static func companies(areaId: String? = nil) -> CollectionTarget {
        areaTarget(DatabaseKey.companies, areaId: areaId)
    }

    /// The collection of the events, of every area or of one (Work events). It is not the calendar.
    public static func events(areaId: String? = nil) -> CollectionTarget {
        areaTarget(DatabaseKey.events, areaId: areaId)
    }

    /// The collection of the files: of every area (Home, Health and Work files), of one project, or of all.
    public static func files(areaId: String? = nil, projectId: String? = nil) -> CollectionTarget {
        if let projectId {
            return .ofItem(databaseKey: DatabaseKey.files, relationKey: DatabaseKey.projects, itemId: projectId)
        }
        return areaTarget(DatabaseKey.files, areaId: areaId)
    }

    // MARK: - Items
    /// The detail of any item: its properties, its page and the collections connected to it. A project has the
    /// layout of a project, with its notes, agent, tasks and related collections.
    public static func item(
        itemId: String,
        makeModel: @escaping @MainActor () -> any ItemScreenModel,
        router: any CollectionsRouting
    ) -> some View {
        ItemScreen(viewModel: ItemViewModel(itemId: itemId, model: makeModel(), router: router))
    }
}

// MARK: - Private
private extension CollectionsScreenFactory {

    static func areaTarget(_ key: String, areaId: String?) -> CollectionTarget {
        if let areaId {
            return .ofArea(databaseKey: key, areaId: areaId)
        }
        return .whole(databaseKey: key, databaseId: nil)
    }
}
