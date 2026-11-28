import Foundation

// MARK: - Items of any database
extension NavigationContext {

    /// Opens the item `itemId` of the database `databaseKey` from the stack of `tab` the way the design opens items of
    /// that database: a task in its Podrobnosti sheet, an event as its meeting page, a project, a person and an item of
    /// a database the caller does not know as a page pushed onto the stack, and the items of the other databases
    /// (companies, files, books, films, recipes, health records) in a sheet over it.
    func showItem(itemId: String, databaseKey: String?, from tab: AppTab) {
        switch databaseKey {
        case "tasks":
            showDetails(kind: .task, id: itemId, from: tab)
        case "events":
            push(.meeting(eventId: itemId, tab: tab), in: tab)
        case nil, "projects", "people", "journal":
            push(.collectionItem(itemId: itemId, databaseKey: databaseKey), in: tab)
        default:
            presentSheet(.itemSheet(itemId: itemId, databaseKey: databaseKey, tab: tab), from: tab)
        }
    }
}
