import Combine
import CoreKit
import Foundation

/// Thin adapter between the item screens and their shared screen model: republishes the state, forwards intents and
/// turns effects into routing. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class ItemViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any ItemScreenModel
    private let router: any CollectionsRouting
    private let itemId: String

    // MARK: - Published Properties
    @Published private(set) var state: ItemState

    // MARK: - Init
    init(itemId: String, model: any ItemScreenModel, router: any CollectionsRouting) {
        self.itemId = itemId
        self.model = model
        self.router = router
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state and effects until the screen's task is cancelled.
    func observe() async {
        await model.observe(
            onState: { [weak self] in self?.state = $0 },
            onEffect: { [weak self] in self?.route($0) }
        )
    }

    func send(_ action: ItemAction) {
        model.send(action)
    }

    /// The screens of other features a project's own rows reach.
    func showProject(_ destination: ProjectDestination) {
        switch destination {
        case .tasks: router.showProjectTasks(projectId: itemId)
        case .mail: router.showProjectMail(projectId: itemId)
        case .mailSignals: router.showProjectMailSignals(projectId: itemId)
        case .notes: router.showProjectNotes(projectId: itemId)
        case .agent: router.showProjectAgent(projectId: itemId)
        case .files:
            router.showCollection(
                .ofItem(databaseKey: DatabaseKey.files, relationKey: DatabaseKey.projects, itemId: itemId)
            )
        }
    }
}

/// Where a row of a project's screen leads.
enum ProjectDestination: Equatable {

    case tasks, mail, mailSignals, notes, agent, files
}

// MARK: - Private
private extension ItemViewModel {

    func route(_ effect: ItemEffect) {
        switch effect {
        case .openItem(let id, let databaseKey):
            switch databaseKey {
            case DatabaseKey.events: router.showEvent(itemId: id)
            case DatabaseKey.areas: router.showArea(areaId: id)
            default: router.showItem(itemId: id, databaseKey: databaseKey)
            }
        case .openCollection(let databaseId, let databaseKey, let filterJson):
            openCollection(databaseId: databaseId, databaseKey: databaseKey, filterJson: filterJson)
        case .close:
            break
        }
    }

    /// A related collection opens as a collection of the items it counts. Tasks and mail of a project belong to
    /// other features, and a collection without a filter (mail threads) cannot be queried here.
    func openCollection(databaseId: String, databaseKey: String?, filterJson: String?) {
        let isProject = state.header?.databaseKey == DatabaseKey.projects
        switch databaseKey {
        case DatabaseKey.tasks where isProject: router.showProjectTasks(projectId: itemId)
        case DatabaseKey.threads where isProject: router.showProjectMail(projectId: itemId)
        default:
            guard let filterJson else { return }
            router.showCollection(.matching(databaseKey: databaseKey, databaseId: databaseId, filterJson: filterJson))
        }
    }
}
