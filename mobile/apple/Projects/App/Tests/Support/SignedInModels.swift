import CoreKit

/// The real screen models of a scene, except that the session is already signed in, so a test of the scene's tabs
/// does not stop at the sign-in form.
@MainActor
final class SignedInModels: ScreenModelFactory {

    // MARK: - Dependencies
    private let real = SharedScreenModelFactory()

    // MARK: - Protocol conformance
    func makeLogin() -> any LoginScreenModel { real.makeLogin() }

    func makeOverview() -> any OverviewScreenModel { real.makeOverview() }

    func makeSearch() -> any SearchScreenModel { real.makeSearch() }

    func makeTasks(start: TasksStart) -> any TasksScreenModel { real.makeTasks(start: start) }

    func makeItemDetails(kind: ItemKind, itemId: String) -> any ItemDetailsScreenModel {
        real.makeItemDetails(kind: kind, itemId: itemId)
    }

    func makeCollection(target: CollectionTarget) -> any CollectionScreenModel { real.makeCollection(target: target) }

    func makeItem(itemId: String, databaseKey: String?) -> any ItemScreenModel {
        real.makeItem(itemId: itemId, databaseKey: databaseKey)
    }

    func makeJournal(initialDay: String) -> any JournalScreenModel { real.makeJournal(initialDay: initialDay) }

    func makeJournalSubpage(itemId: String) -> any JournalSubpageScreenModel {
        real.makeJournalSubpage(itemId: itemId)
    }

    func makeSleep(night: String?, startOnNight: Bool) -> any SleepScreenModel {
        real.makeSleep(night: night, startOnNight: startOnNight)
    }

    func makeCalendar(initialDay: String) -> any CalendarScreenModel { real.makeCalendar(initialDay: initialDay) }

    func makeCalendarList() -> any CalendarListScreenModel { real.makeCalendarList() }

    func makeInvitations() -> any InvitationsScreenModel { real.makeInvitations() }

    func makeNewItem(day: String) -> any NewItemScreenModel { real.makeNewItem(day: day) }

    func makeSession() -> any SessionScreenModel {
        ScriptedSessionScreenModel(
            state: .signedIn(SessionUser(email: "a@b.cz", role: "member", serverUrl: "https://s.example"))
        )
    }
}
