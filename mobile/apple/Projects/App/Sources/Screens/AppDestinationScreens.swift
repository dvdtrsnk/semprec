import CalendarFeature
import CollectionsFeature
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

/// The page of notes of an item, on the stack of `tab`.
struct NotesDestination: View {

    let itemId: String
    let tab: AppTab
    /// The titles of the pages above a subpage, outermost first; empty for a page of its own.
    let trail: [String]
    let focusTitle: Bool
    let composition: AppComposition

    var body: some View {
        // A subpage's title is its block in the parent page, which renaming changes.
        NotesScreenFactory.page(
            trail: trail,
            focusTitle: focusTitle,
            makeModel: {
                composition.models.makeNoteEditor(source: .page(itemId: itemId, titleEditable: !trail.isEmpty))
            },
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
            makeNote: { composition.models.makeNoteEditor(source: $0) },
            router: composition.inboxRouter(in: tab)
        )
    }
}

/// The tags of the projects (`projectTags` and `projectTag`), each screen over a model of the project they were
/// reached from.
struct ProjectTagsDestination: View {

    let destination: AppDestination
    let composition: AppComposition

    var body: some View {
        switch destination {
        case .projectTags(let projectId):
            CollectionsScreenFactory.projectTags(
                projectId: projectId,
                makeModel: { composition.models.makeItem(itemId: projectId, databaseKey: "projects") },
                router: composition.collectionsRouter
            )
        case .projectTag(let projectId, let tagKey):
            CollectionsScreenFactory.projectTag(
                projectId: projectId,
                tagKey: tagKey,
                makeModel: { composition.models.makeItem(itemId: projectId, databaseKey: "projects") },
                router: composition.collectionsRouter
            )
        default:
            EmptyView()
        }
    }
}

/// The sleep sheets: the plan, one night, and the wake settings (`sleepPlan`, `sleepNight` and `sleepWakeSettings`).
struct SleepDestination: View {

    let destination: AppDestination
    let composition: AppComposition

    var body: some View {
        switch destination {
        case .sleepPlan(let night):
            SleepScreenFactory.plan(
                makeModel: { composition.models.makeSleep(night: night, startOnNight: false) },
                router: composition.sleepRouter
            )
        case .sleepNight(let night):
            SleepScreenFactory.night(
                makeModel: { composition.models.makeSleep(night: night, startOnNight: true) },
                router: composition.sleepRouter
            )
        case .sleepWakeSettings:
            SleepScreenFactory.wakeSettings { composition.models.makeWakeSettings() }
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
        case .profile(let opening):
            ProfileSheet(
                opening: opening,
                models: composition.models,
                navigation: composition.navigation,
                notifications: composition.notifications
            )
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
