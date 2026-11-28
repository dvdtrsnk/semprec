import CoreKit
import Foundation
import OverviewFeature

/// Routes of the Overview feature, on the Overview tab's stack. Screens that later waves build open as a notice that
/// names what was asked for, so that no row is a dead end; the profile opens as a sheet.
@MainActor
final class AppOverviewRouter {

    // MARK: - Dependencies
    private let context: NavigationContext

    // MARK: - Init
    init(context: NavigationContext) {
        self.context = context
    }
}

// MARK: - Protocol conformance
extension AppOverviewRouter: OverviewRouting {

    func show(_ target: OverviewTarget) {
        switch target {
        case .profile: context.presentSheet(.profile(), from: .overview)
        case .inbox: context.showInbox(in: .overview)
        case .mail: context.showMail(MailListStart(), in: .overview)
        case .recordings: context.push(.recordings(tab: .overview), in: .overview)
        case .tasks: context.showTasks(TasksStart(), in: .overview)
        case .finance: pending(String(localized: "pending.finance"))
        case .project(let id): context.push(.collectionItem(itemId: id, databaseKey: "projects"), in: .overview)
        case .collection(_, let databaseId):
            context.push(.collection(.whole(databaseKey: nil, databaseId: databaseId)), in: .overview)
        }
    }

    func showSearchResult(_ link: SearchResultLink) {
        switch (link.type, link.itemId) {
        case (.task, let id?): context.showDetails(kind: .task, id: id, from: .overview)
        case (.event, let id?): context.showDetails(kind: .event, id: id, from: .overview)
        case (.project, let id?): context.push(.collectionItem(itemId: id, databaseKey: "projects"), in: .overview)
        case (.contact, let id?), (.file, let id?):
            context.showItem(itemId: id, databaseKey: link.databaseKey, from: .overview)
        case (.journal, _): context.select(.journal)
        case (.mail, _):
            if let thread = link.threadId {
                context.push(.mailThread(threadId: thread, tab: .overview), in: .overview)
            } else {
                pending(String(localized: "pending.searchResult"))
            }
        default: pending(String(localized: "pending.searchResult"))
        }
    }
}

// MARK: - Private
private extension AppOverviewRouter {

    func pending(_ title: String) {
        context.push(.pending(title: title), in: .overview)
    }
}
