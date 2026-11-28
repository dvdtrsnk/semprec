/// A page the project settings push on their own stack.
enum ProjectSettingsPage: Hashable {

    /// Every tag of the projects, to be renamed, recolored or deleted.
    case tags
    /// One tag, by its key.
    case tag(key: String)
}
