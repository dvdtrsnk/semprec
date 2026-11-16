/// Accessibility identifiers of the Collections feature's elements.
enum CollectionsIdentifiers {

    // MARK: - Collection
    static let collectionScreen = "collection.screen"
    /// Followed by the item id, e.g. `collection.row.p1`.
    static let rowPrefix = "collection.row."
    /// Followed by the quick filter key.
    static let quickFilterPrefix = "collection.quickFilter."
    static let filterButton = "collection.filter"
    static let filterSheet = "collection.filterSheet"
    static let layoutMenu = "collection.layoutMenu"
    static let addButton = "collection.add"
    static let newItemField = "collection.newItemField"
    static let newItemSheet = "collection.newItemSheet"
    static let newItemSave = "collection.newItemSave"
    static let loadMore = "collection.loadMore"

    // MARK: - Item
    static let itemScreen = "item.screen"
    static let itemTitle = "item.title"
    /// Followed by the property key, e.g. `item.field.status`.
    static let fieldPrefix = "item.field."
    /// Followed by the property key.
    static let originPrefix = "item.origin."
    static let pickerSheet = "item.picker"
    static let previewSheet = "item.preview"
    static let pageEditor = "item.pageEditor"
    static let deleteButton = "item.delete"
    static let closeItem = "item.close"
    static let mediaStatus = "item.media.status"
    static let mediaRating = "item.media.rating"
    /// Followed by the database id.
    static let relatedPrefix = "item.related."
    static let projectSettings = "project.settings"
}
