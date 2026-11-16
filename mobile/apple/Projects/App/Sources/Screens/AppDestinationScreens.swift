import CalendarFeature
import JournalFeature
import SwiftUI

// Concrete views for destinations of `AppScene.destinationView`: opaque helper functions inside its large
// conditional-content tree crash the Swift 6.4 compiler while it emits a reabstraction thunk.

/// The calendars sheet: which calendars show, their colours and notifications.
struct CalendarsSheet: View {

    let composition: AppComposition

    var body: some View {
        NavigationStack {
            CalendarScreenFactory.calendars(
                makeModel: { composition.models.makeCalendarList() },
                router: composition.calendarRouter
            )
        }
    }
}

/// The invitations sheet.
struct InvitationsSheet: View {

    let composition: AppComposition

    var body: some View {
        NavigationStack {
            CalendarScreenFactory.invitations(makeModel: { composition.models.makeInvitations() })
        }
    }
}

/// The new item sheet, opened for the day `day` (`YYYY-MM-DD`).
struct NewItemSheet: View {

    let day: String
    let composition: AppComposition

    var body: some View {
        NavigationStack {
            CalendarScreenFactory.newItem(day: day, makeModel: { composition.models.makeNewItem(day: $0) })
        }
    }
}

/// A subpage of the diary; `title` is the caption of the link that opened it.
struct JournalSubpageScreen: View {

    let itemId: String
    let title: String
    let composition: AppComposition

    var body: some View {
        JournalScreenFactory.subpage(
            title: title,
            makeModel: { composition.models.makeJournalSubpage(itemId: itemId) },
            router: composition.journalRouter
        )
    }
}
