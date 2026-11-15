@preconcurrency internal import SharedSDK

// MARK: - Collections
extension SharedScreenModelFactory {

    public func makeCollection(target: CollectionTarget) -> any CollectionScreenModel {
        SharedCollectionScreenModel(sdk.collectionViewModel(target: SharedCollectionScreenModel.target(target)))
    }

    public func makeItem(itemId: String, databaseKey: String?) -> any ItemScreenModel {
        SharedItemScreenModel(sdk.itemViewModel(itemId: itemId, databaseKeyHint: databaseKey))
    }
}
