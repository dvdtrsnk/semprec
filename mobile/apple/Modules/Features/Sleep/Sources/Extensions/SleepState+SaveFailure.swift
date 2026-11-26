import CoreKit

// MARK: - Save failure
extension SleepState {

    /// Whether the overview presents the failure of a write: an open editor presents it itself, because an alert
    /// cannot show under a sheet, and the overview does once the editor is closed.
    var overviewShowsSaveFailure: Bool {
        saveFailed && editor == nil
    }
}
