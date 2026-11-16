@preconcurrency internal import SharedSDK

// MARK: - Collections
extension SharedScreenModelFactory {

    public func makeCollection(target: CollectionTarget) -> any CollectionScreenModel {
        SharedCollectionScreenModel(
            sdk.collections.collectionViewModel(target: SharedCollectionScreenModel.target(target))
        )
    }

    public func makeItem(itemId: String, databaseKey: String?) -> any ItemScreenModel {
        SharedItemScreenModel(sdk.collections.itemViewModel(itemId: itemId, databaseKeyHint: databaseKey))
    }
}
