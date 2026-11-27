import CoreKit

// MARK: - Tasks and Podrobnosti
extension NavigationContext {

    /// Presents the Podrobnosti sheet of the task or event `id` over the stack of `tab`: the one call every screen that
    /// lists tasks or events uses to open one for editing. The Calendar opens it for an event and a task alike; the
    /// Tasks screen opens it for a task. The sheet edits the item in place and tells the open lists to load again.
    func showDetails(kind: ItemKind, id: String, from tab: AppTab) {
        presentSheet(.details(ItemDetailsTarget(kind: kind, id: id, tab: tab)), from: tab)
    }

    /// Pushes the Tasks screen, started as `start` says (today or the tasks of a project), onto the stack of `tab`.
    func showTasks(_ start: TasksStart, in tab: AppTab) {
        push(.tasks(start, tab: tab), in: tab)
    }
}

// MARK: - Inbox
extension NavigationContext {

    /// Pushes the Inbox onto the stack of `tab`.
    func showInbox(in tab: AppTab) {
        push(.inbox(tab: tab), in: tab)
    }
}
