import Foundation

/// The directory where the shared layer keeps the offline data of the process: the windows' `SharedScreenModelFactory`
/// and the system entry points' `InboxShortcutCapture` name the same one, so they share one `OfflineLayer`.
enum OfflineDirectory {

    /// `Application Support/Offline`, which the system does not empty as it may empty the caches, created and excluded
    /// from backups: it holds a copy of the server's data, which a restored device reads again. When the directory
    /// cannot be created or excluded here, its path is still handed over: the shared layer creates it on its first
    /// write, and it is then backed up with the app's other data, which loses nothing.
    static func path() -> String {
        var directory = URL.applicationSupportDirectory.appendingPathComponent("Offline", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? directory.setResourceValues(values)
        return directory.path
    }
}
