import CoreKit

extension JournalState {

    /// The diary as it shows `content`: its period selected and shown, with what it lists, and nothing beside it.
    func showing(_ content: JournalPeriodContent) -> JournalState {
        JournalState(
            phase: .content,
            selection: content.shown,
            today: today,
            axis: axis,
            page: content.page,
            weeks: content.weeks,
            quarters: content.quarters,
            events: content.events,
            birthdays: content.birthdays,
            inbox: content.inbox,
            shown: content.shown
        )
    }
}
