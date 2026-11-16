@preconcurrency internal import SharedSDK

/// The Kotlin `TasksViewModel` as a `TasksScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedTasksScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.TasksViewModel
    private let effectQueue: EffectQueue<TasksEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.TasksViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedTasksScreenModel: ScreenModel {

    var state: TasksState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<TasksState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<TasksEffect> {
        effectQueue.stream()
    }

    func send(_ action: TasksAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedTasksScreenModel {

    static func state(_ state: SharedSDK.TasksState) -> TasksState {
        TasksState(
            phase: phase(state),
            tab: TasksTab(state.tab),
            hideDone: state.hideDone,
            areaId: state.areaId,
            projectId: state.projectId,
            flaggedOnly: state.flaggedOnly,
            groups: state.groups.map(group),
            openCount: Int(state.openCount),
            areaOptions: state.areaOptions.map(option),
            projectOptions: state.projectOptions.map(option),
            areaAllCount: Int(state.areaAllCount),
            projectAllCount: Int(state.projectAllCount),
            matchesNothing: state.matchesNothing,
            notice: state.notice.map(FailureKind.init)
        )
    }

    static func action(_ action: TasksAction) -> any SharedSDK.TasksAction {
        switch action {
        case .selectTab(let tab): SharedSDK.TasksActionSelectTab(tab: tab.shared)
        case .toggleHideDone: SharedSDK.TasksActionToggleHideDone.shared
        case .setArea(let id): SharedSDK.TasksActionSetArea(areaId: id)
        case .setProject(let id): SharedSDK.TasksActionSetProject(projectId: id)
        case .setFlaggedOnly(let flagged): SharedSDK.TasksActionSetFlaggedOnly(flaggedOnly: flagged)
        case .clearFilters: SharedSDK.TasksActionClearFilters.shared
        case .retry: SharedSDK.TasksActionRetry.shared
        case .refresh: SharedSDK.TasksActionRefresh.shared
        case .toggleDone(let id): SharedSDK.TasksActionToggleDone(taskId: id)
        case .rename(let id, let title): SharedSDK.TasksActionRename(taskId: id, title: title)
        case .add(let title): SharedSDK.TasksActionAdd(title: title)
        case .openDetails(let id): SharedSDK.TasksActionOpenDetails(taskId: id)
        case .dismissNotice: SharedSDK.TasksActionDismissNotice.shared
        }
    }

    static func effect(_ effect: any SharedSDK.TasksEffect) -> TasksEffect {
        switch onEnum(of: effect) {
        case .openDetails(let openDetails): .openDetails(taskId: openDetails.taskId)
        }
    }

    private static func phase(_ state: SharedSDK.TasksState) -> TasksPhase {
        switch state.phase {
        case .loading: .loading
        case .content: .content
        case .error: .failure(state.failure.map(FailureKind.init))
        }
    }

    private static func group(_ group: SharedSDK.TaskGroup) -> TaskGroup {
        TaskGroup(kind: TaskSectionKind(group.kind), rows: group.rows.map(row))
    }

    private static func row(_ row: SharedSDK.TaskRow) -> TaskRow {
        TaskRow(
            id: row.id,
            title: row.title,
            done: row.done,
            flagged: row.flagged,
            date: row.date,
            timeFrom: row.timeFrom,
            timeTo: row.timeTo,
            movedFrom: row.movedFrom,
            projectTitle: row.projectTitle,
            repeats: TaskRepeat(row.repeat),
            overdue: row.overdue,
            missed: row.missed
        )
    }

    private static func option(_ option: SharedSDK.TaskFilterOption) -> TaskFilterOption {
        TaskFilterOption(
            id: option.id,
            title: option.title,
            color: option.color,
            count: Int(option.count),
            areaId: option.areaId
        )
    }
}
