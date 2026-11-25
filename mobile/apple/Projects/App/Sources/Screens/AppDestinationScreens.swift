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

/// The sleep sheet: the plan (`sleepPlan`), or one night it opens on (`sleepNight`), with the screen of how its
/// alarms wake the person where the device rings alarms.
struct SleepDestination: View {

    /// The evening whose night the sheet shows, if any.
    let night: String?
    /// Whether the sheet opens on that night rather than on the plan.
    let startsOnNight: Bool
    let composition: AppComposition

    var body: some View {
        if startsOnNight {
            SleepScreenFactory.night(
                makeModel: { composition.models.makeSleep(night: night, startOnNight: true) },
                wakeSettings: Self.wakeSettings
            )
        } else {
            SleepScreenFactory.plan(
                makeModel: { composition.models.makeSleep(night: night, startOnNight: false) },
                wakeSettings: Self.wakeSettings
            )
        }
    }

    /// How the sleep plan's alarms wake the person on this device; nil where the device rings no system alarm.
    static var wakeSettings: (@MainActor () -> AnyView)? {
        guard SystemAlarmScheduler().isSupported, let clock = AppNotifications.shared.sleepAlarms else { return nil }
        return { AnyView(SleepWakeScreen(clock: clock)) }
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
