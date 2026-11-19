import AreasFeature
import CalendarFeature
import InboxFeature
import JournalFeature
import NotesFeature
import SempFeature
import SleepFeature
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

/// One area, on the stack of `tab`.
struct AreaDestination: View {

    let areaId: String
    let tab: AppTab
    let composition: AppComposition

    var body: some View {
        AreasScreenFactory.area(
            areaId: areaId,
            makeModel: { composition.models.makeArea(areaId: areaId) },
            router: composition.areasRouter(in: tab)
        )
    }
}

/// The page of notes of an item, on the stack of `tab`.
struct NotesDestination: View {

    let itemId: String
    let tab: AppTab
    let composition: AppComposition

    var body: some View {
        NotesScreenFactory.page(
            makeModel: { composition.models.makeNoteEditor(source: .page(itemId: itemId, titleEditable: false)) },
            router: composition.notesRouter(in: tab)
        )
    }
}

/// The Inbox, on the stack of `tab`.
struct InboxDestination: View {

    let tab: AppTab
    let composition: AppComposition

    var body: some View {
        InboxScreenFactory.inbox(
            makeModel: { composition.models.makeInbox() },
            router: composition.inboxRouter(in: tab)
        )
    }
}

/// The sleep sheet: the plan, or one night (`sleepPlan` and `sleepNight` destinations).
struct SleepDestination: View {

    let destination: AppDestination
    let composition: AppComposition

    var body: some View {
        switch destination {
        case .sleepPlan(let night):
            SleepScreenFactory.plan { composition.models.makeSleep(night: night, startOnNight: false) }
        case .sleepNight(let night):
            SleepScreenFactory.night { composition.models.makeSleep(night: night, startOnNight: true) }
        default:
            EmptyView()
        }
    }
}

/// The destinations of the app's own screens: the notice for a screen that is not built, the profile and Semp.
struct ShellDestination: View {

    let destination: AppDestination
    let composition: AppComposition

    var body: some View {
        switch destination {
        case .pending(let title):
            PendingScreen(title: title)
        case .profile:
            ProfileSheet(models: composition.models, navigation: composition.navigation)
        case .sempProjectAgent(let projectId):
            SempScreenFactory.projectAgent(
                makeModel: { composition.models.makeSempProjectAgent(projectId: projectId) },
                router: composition.sempRouter
            )
        default:
            SempScreenFactory.status(
                makeModel: { composition.models.makeSempStatus() },
                router: composition.sempRouter
            )
        }
    }
}
