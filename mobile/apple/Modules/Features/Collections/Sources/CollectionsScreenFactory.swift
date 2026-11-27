import CoreKit
import SwiftUI

/// The screens of the Collections feature. A screen calls `makeModel` once, when SwiftUI creates its `@StateObject`,
/// and owns that model for as long as SwiftUI keeps the screen.
///
/// There is one collection screen and one item screen. The concrete screens of the design are those two over
/// different data: `projects`, `people`, `companies`, `events` and `files` name the collection of each database,
/// or narrowed to the item it hangs on; `item` shows any item, with the layout of a project for a project.
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

    public static func projects() -> CollectionTarget {
        .whole(databaseKey: DatabaseKey.projects, databaseId: nil)
    }

    public static func people() -> CollectionTarget {
        .whole(databaseKey: DatabaseKey.people, databaseId: nil)
    }

    public static func companies() -> CollectionTarget {
        .whole(databaseKey: DatabaseKey.companies, databaseId: nil)
    }

    /// The collection of the events. It is not the calendar.
    public static func events() -> CollectionTarget {
        .whole(databaseKey: DatabaseKey.events, databaseId: nil)
    }

    /// The collection of the files: of one project, or of all.
    public static func files(projectId: String? = nil) -> CollectionTarget {
        if let projectId {
            return .ofItem(databaseKey: DatabaseKey.files, relationKey: DatabaseKey.projects, itemId: projectId)
        }
        return .whole(databaseKey: DatabaseKey.files, databaseId: nil)
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

    /// The same detail in a sheet of its own, with a button that closes it: how the items of companies, files, books,
    /// films, recipes and health records open.
    public static func itemSheet(
        itemId: String,
        makeModel: @escaping @MainActor () -> any ItemScreenModel,
        router: any CollectionsRouting
    ) -> some View {
        ItemSheet {
            ItemScreen(viewModel: ItemViewModel(itemId: itemId, model: makeModel(), router: router))
        }
    }
}
