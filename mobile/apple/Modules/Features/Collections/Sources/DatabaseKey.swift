/// The canonical keys of the system databases this feature treats specially.
enum DatabaseKey {

    static let projects = "projects"
    static let events = "events"
    static let tasks = "tasks"
    static let threads = "threads"
    static let files = "files"
    static let people = "people"
    static let companies = "companies"
    static let books = "books"
    static let movies = "movies"

    /// Books and films, whose items have a cover, a status, stars and notes.
    static func isMedia(_ key: String?) -> Bool {
        key == books || key == movies
    }
}
