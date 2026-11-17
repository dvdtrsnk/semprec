import TasksFeature

/// Routes of the Tasks feature: the Tasks screen sits on the stack of one tab, and the Podrobnosti sheet it opens is
/// presented over that stack.
@MainActor
final class AppTasksRouter {

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
extension AppTasksRouter: TasksRouting {

    func showDetails(taskId: String) {
        context.showDetails(kind: .task, id: taskId, from: tab)
    }
}
