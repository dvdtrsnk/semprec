import Foundation

/// What the Tasks screen asks of the app's navigation. The app decides where the Podrobnosti sheet is presented.
@MainActor
public protocol TasksRouting: AnyObject {

    /// Shows the Podrobnosti sheet of the task `taskId`.
    func showDetails(taskId: String)
}

/// A router for previews: it goes nowhere.
@MainActor
final class PreviewTasksRouter: TasksRouting {

    func showDetails(taskId: String) {}
}
