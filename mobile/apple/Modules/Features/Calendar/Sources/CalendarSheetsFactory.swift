import CoreKit
import SwiftUI

// MARK: - Sheets
public extension CalendarScreenFactory {

    /// The calendars sheet: which calendars show, their colours and notifications. The app presents it inside its own
    /// `NavigationStack`; the sheet dismisses itself. `router` opens the sleep plan from the sleep calendar's row.
    static func calendars(
        makeModel: @escaping @MainActor () -> any CalendarListScreenModel,
        router: any CalendarRouting
    ) -> some View {
        CalendarListScreen(viewModel: CalendarListViewModel(model: makeModel(), router: router))
    }

    /// The invitations sheet. The app presents it inside its own `NavigationStack`; the sheet dismisses itself.
    static func invitations(makeModel: @escaping @MainActor () -> any InvitationsScreenModel) -> some View {
        InvitationsScreen(viewModel: InvitationsViewModel(model: makeModel()))
    }

    /// The new item sheet for `day` (`YYYY-MM-DD`). The app presents it inside its own `NavigationStack`; the sheet
    /// dismisses itself when it is cancelled or the item was created.
    static func newItem(
        day: String,
        makeModel: @escaping @MainActor (_ day: String) -> any NewItemScreenModel
    ) -> some View {
        NewItemScreen(day: day, viewModel: NewItemViewModel(model: makeModel(day)))
    }
}
