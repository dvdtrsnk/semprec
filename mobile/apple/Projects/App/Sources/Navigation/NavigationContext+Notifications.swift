import CoreKit

// MARK: - Notifications
extension NavigationContext {

    /// Opens what a tapped notification leads to, on the Calendar tab: the Podrobnosti sheet of the event or the task,
    /// or the invitations sheet. The tab's stack may not exist yet when the app was launched by the tap; the route then
    /// waits until the tab appears.
    func open(_ target: NotificationTarget) {
        switch target {
        case .event(let id):
            whenShown(.calendar) { $0.showDetails(kind: .event, id: id, from: .calendar) }
        case .task(let id):
            whenShown(.calendar) { $0.showDetails(kind: .task, id: id, from: .calendar) }
        case .invitations:
            whenShown(.calendar) { $0.presentSheet(.invitations, from: .calendar) }
        }
    }
}
