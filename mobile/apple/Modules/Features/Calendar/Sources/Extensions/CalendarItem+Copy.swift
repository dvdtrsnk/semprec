import CoreKit
import Foundation

// MARK: - Copy
extension CalendarItem {

    /// What a trace says about the chain of a carried-over task on its day.
    @MainActor var traceDescription: String? {
        guard let trace else { return nil }
        switch trace {
        case .carried: return String(localized: "calendar.trace.carried", bundle: .module)
        case .missed: return String(localized: "calendar.trace.missed", bundle: .module)
        case .done:
            return String(format: String(localized: "calendar.trace.done", bundle: .module), dayName(traceNote))
        case .movedToEvent:
            return String(format: String(localized: "calendar.trace.movedToEvent", bundle: .module), traceNote ?? "")
        }
    }

    /// `přesunuto z čt 15. 10.`, for a task that was carried to this day.
    @MainActor var carriedDescription: String? {
        carriedFrom.map { String(format: String(localized: "calendar.carriedFrom", bundle: .module), dayName($0)) }
    }

    /// `z Schůzka s klientem · nesplněno`, for a task that was put into an event that ended without it being done.
    @MainActor var hostedDescription: String? {
        guard let hostEventTitle, !done else { return nil }
        return String(format: String(localized: "calendar.hostedFrom", bundle: .module), hostEventTitle)
    }

    /// The label of the checkbox in front of a task.
    var toggleLabel: String {
        let key = done ? "calendar.toggle.open" : "calendar.toggle.done"
        return String(format: String(localized: String.LocalizationValue(key), bundle: .module), title)
    }

    @MainActor
    private func dayName(_ day: String?) -> String {
        day.map(CalendarDates.shortDate) ?? ""
    }
}

// MARK: - Task in an event
extension CalendarEventTask {

    /// The label of the checkbox in front of the task.
    var toggleLabel: String {
        let key = isDone ? "calendar.toggle.open" : "calendar.toggle.done"
        return String(format: String(localized: String.LocalizationValue(key), bundle: .module), title)
    }

    /// What the state of the task says next to it, or nil for an open or a done task.
    @MainActor var stateNote: String? {
        switch state {
        case .open, .done: nil
        case .missed: String(localized: "calendar.task.missed", bundle: .module)
        case .moved: String(format: String(localized: "calendar.task.moved", bundle: .module), note ?? "")
        case .doneElsewhere: doneElsewhereNote
        }
    }

    @MainActor private var doneElsewhereNote: String {
        // The server gives the name of the other event, or the day a task was completed on.
        if let note, CalendarDates.date(note) != nil {
            return String(
                format: String(localized: "calendar.task.doneOn", bundle: .module),
                CalendarDates.shortDate(note)
            )
        }
        return String(format: String(localized: "calendar.task.doneIn", bundle: .module), note ?? "")
    }

    /// Done in this event: a task completed elsewhere, on its own row or in another event, was not done here.
    var isDone: Bool { state == .done }

    /// Whether the note says the task was not done in this event: missed there, or done somewhere else.
    var isNotDoneHere: Bool { state == .missed || state == .doneElsewhere }
}
