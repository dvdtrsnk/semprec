/// Accessibility identifiers of the Home feature's elements; each equals the Android test tag of the same element.
/// Android's `detail.back` has no counterpart: on iOS and macOS the back button belongs to the system navigation stack.
enum HomeIdentifiers {

    static let screen = "home.screen"
    /// Followed by the item id, e.g. `home.item.item-1`.
    static let itemPrefix = "home.item."
    static let detailScreen = "detail.screen"
    /// The item's title on the detail screen.
    static let detailTitle = "detail.title"
}
