import CoreKit
import SwiftUI

// MARK: - Save failure
extension SleepState {

    /// Whether the overview presents the failure of a write: an open editor presents it itself, because an alert
    /// cannot show under a sheet, and the overview does once the editor is closed.
    var overviewShowsSaveFailure: Bool {
        saveFailed && editor == nil
    }

    /// Whether the editor sheet presents the failure of a write: exactly when the overview does not, so one failure
    /// never shows two alerts.
    var editorShowsSaveFailure: Bool {
        saveFailed && editor != nil
    }
}

// MARK: - Presentation
/// Which sheets and alerts the sleep screen presents, and what closing them by the system sends: all of it follows the
/// shared state, so closing sends an intent and never changes anything the screen holds.
struct SleepPresentation {

    // MARK: - Dependencies
    let state: SleepState
    let send: (SleepAction) -> Void

    // MARK: - Bindings
    /// Whether the editor shows; closing it by the system (a swipe down) discards its draft.
    var editor: Binding<Bool> {
        Binding(
            get: { state.editor != nil },
            set: { if !$0 { send(.draft(.discard)) } }
        )
    }

    /// The failure of a write on the overview, when no editor is open.
    var overviewFailure: Binding<Bool> {
        Binding(
            get: { state.overviewShowsSaveFailure },
            set: { if !$0 { send(.dismissSaveFailure) } }
        )
    }

    /// The failure of a write in the open editor: an alert cannot show under a sheet, so the editor shows its own.
    var editorFailure: Binding<Bool> {
        Binding(
            get: { state.editorShowsSaveFailure },
            set: { if !$0 { send(.dismissSaveFailure) } }
        )
    }
}
