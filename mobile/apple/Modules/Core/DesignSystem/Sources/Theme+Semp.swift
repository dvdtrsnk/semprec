import SwiftUI

// MARK: - Semp
extension Theme.Colors {

    /// The colors of the kinds of object that Semp can be given, one per kind.
    public enum SempKind {

        public static let task = Color(red: 0.0, green: 0.478, blue: 1.0)
        public static let event = Color(red: 1.0, green: 0.231, blue: 0.188)
        public static let mail = Color(red: 0.11, green: 0.431, blue: 0.839)
        public static let inbox = Color(red: 1.0, green: 0.584, blue: 0.0)
        public static let journal = Color(red: 0.686, green: 0.322, blue: 0.871)
        public static let project = Color(red: 0.557, green: 0.267, blue: 0.678)
        public static let person = Color(red: 0.188, green: 0.69, blue: 0.78)
        public static let company = Color(red: 0.369, green: 0.361, blue: 0.902)
        public static let file = Color(red: 0.388, green: 0.388, blue: 0.4)
        public static let note = Color(red: 0.788, green: 0.533, blue: 0.102)
        public static let recording = Color(red: 0.11, green: 0.11, blue: 0.118)
        public static let finance = Color(red: 0.204, green: 0.78, blue: 0.349)
        public static let health = Color(red: 1.0, green: 0.176, blue: 0.333)
        public static let recipe = Color(red: 0.902, green: 0.494, blue: 0.133)
        public static let book = Color(red: 0.635, green: 0.518, blue: 0.369)
        public static let movie = Color(red: 0.039, green: 0.518, blue: 0.776)
        public static let run = Color(red: 1.0, green: 0.702, blue: 0.0)
        public static let other = Color(red: 0.557, green: 0.557, blue: 0.576)
    }

    /// A step or a run that went well.
    public static let sempSuccess = Color.green
    /// A run, request or step that waits for the person.
    public static let sempWaiting = Color.orange
    /// A run that the schedule of an agent started.
    public static let sempTick = Color(red: 0.345, green: 0.337, blue: 0.839)
}
