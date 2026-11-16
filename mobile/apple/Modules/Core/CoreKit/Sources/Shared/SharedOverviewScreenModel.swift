@preconcurrency internal import SharedSDK

/// The Kotlin `OverviewViewModel` as an `OverviewScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedOverviewScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.OverviewViewModel
    private let effectQueue: EffectQueue<OverviewTarget>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.OverviewViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.target)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedOverviewScreenModel: ScreenModel {

    var state: OverviewState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<OverviewState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<OverviewTarget> {
        effectQueue.stream()
    }

    func send(_ action: OverviewAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedOverviewScreenModel {

    static func state(_ state: SharedSDK.OverviewState) -> OverviewState {
        switch state.phase {
        case .loading: .loading
        case .content: .content(content(state))
        case .error: .failure(state.failure.map(FailureKind.init))
        }
    }

    private static func content(_ state: SharedSDK.OverviewState) -> OverviewContent {
        OverviewContent(
            refreshing: state.refreshing,
            accountEmail: state.accountEmail,
            inboxPending: Int(state.inboxPending),
            mailUnread: Int(state.mailUnread),
            tasksToday: Int(state.tasksToday),
            problemCount: Int(state.problemCount),
            journalTodayItemId: state.journalTodayItemId,
            areas: state.areas.map {
                OverviewArea(
                    id: $0.id,
                    name: $0.name,
                    color: $0.color,
                    icon: $0.icon,
                    activeProjectCount: Int($0.activeProjectCount)
                )
            },
            projects: state.projects.map {
                OverviewProject(id: $0.id, name: $0.name, color: $0.color, areaName: $0.areaName, status: $0.status)
            },
            collections: state.collections.map {
                OverviewCollection(
                    databaseId: $0.databaseId,
                    ownerModuleId: $0.ownerModuleId,
                    name: $0.name,
                    icon: $0.icon,
                    color: $0.color,
                    itemCount: Int($0.itemCount)
                )
            }
        )
    }

    static func action(_ action: OverviewAction) -> any SharedSDK.OverviewAction {
        switch action {
        case .retry: SharedSDK.OverviewActionRetry.shared
        case .refresh: SharedSDK.OverviewActionRefresh.shared
        case .open(let target): SharedSDK.OverviewActionOpen(target: sharedTarget(target))
        }
    }

    static func target(_ target: any SharedSDK.OverviewTarget) -> OverviewTarget {
        switch onEnum(of: target) {
        case .inbox: .inbox
        case .mail: .mail
        case .recordings: .recordings
        case .tasks: .tasks
        case .finance: .finance
        case .profile: .profile
        case .journal(let journal): .journal(itemId: journal.itemId)
        case .area(let area): .area(id: area.id)
        case .project(let project): .project(id: project.id)
        case .collection(let collection):
            .collection(ownerModuleId: collection.ownerModuleId, databaseId: collection.databaseId)
        }
    }

    static func sharedTarget(_ target: OverviewTarget) -> any SharedSDK.OverviewTarget {
        switch target {
        case .inbox: SharedSDK.OverviewTargetInbox.shared
        case .mail: SharedSDK.OverviewTargetMail.shared
        case .recordings: SharedSDK.OverviewTargetRecordings.shared
        case .tasks: SharedSDK.OverviewTargetTasks.shared
        case .finance: SharedSDK.OverviewTargetFinance.shared
        case .profile: SharedSDK.OverviewTargetProfile.shared
        case .journal(let itemId): SharedSDK.OverviewTargetJournal(itemId: itemId)
        case .area(let id): SharedSDK.OverviewTargetArea(id: id)
        case .project(let id): SharedSDK.OverviewTargetProject(id: id)
        case .collection(let ownerModuleId, let databaseId):
            SharedSDK.OverviewTargetCollection(ownerModuleId: ownerModuleId, databaseId: databaseId)
        }
    }
}
