/// Accessibility identifiers of the Collections feature's elements.
enum CollectionsIdentifiers {

    // MARK: - Collection
    static let collectionScreen = "collection.screen"
    /// Followed by the item id, e.g. `collection.row.p1`.
    static let rowPrefix = "collection.row."
    static let filterButton = "collection.filter"
    static let filterMenu = "collection.filterMenu"
    static let filterSheet = "collection.filterSheet"
    static let layoutMenu = "collection.layoutMenu"
    static let addButton = "collection.add"
    static let newItemField = "collection.newItemField"
    static let newItemSheet = "collection.newItemSheet"
    static let newItemSave = "collection.newItemSave"
    static let loadMore = "collection.loadMore"
    static let facetBar = "collection.facetBar"
    /// Followed by the value the chip stands for, e.g. `collection.facetBar.chip.client`.
    static let facetBarChipPrefix = "collection.facetBar.chip."

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
    static let projectMailSignals = "project.settings.mailSignals"
    static let projectTags = "project.tags"
    static let projectSettingsTags = "project.settings.tags"
    static let projectTagsSheet = "project.settings.tags.sheet"
    static let projectTagsCancel = "project.settings.tags.cancel"
    static let projectTagsDone = "project.settings.tags.done"
    static let projectSettingsNewTag = "project.settings.tags.new"
    /// Followed by the tag's key, e.g. `project.settings.tags.chip.client`.
    static let projectTagChipPrefix = "project.settings.tags.chip."
    static let projectTagName = "project.settings.tag.name"
    static let projectTagRename = "project.settings.tag.rename"
    static let projectTagDelete = "project.settings.tag.delete"
    static let projectTagDeleteConfirm = "project.settings.tag.delete.confirm"
}
