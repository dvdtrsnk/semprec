package cz.semprec.app.presentation

import cz.semprec.app.domain.CollectionReads
import cz.semprec.app.domain.CollectionScope
import cz.semprec.app.domain.CollectionWrites
import cz.semprec.app.domain.FilterTree
import cz.semprec.app.domain.FindRelationTargets
import cz.semprec.app.domain.LoadItemDetail
import cz.semprec.app.domain.OpenCollection
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the ViewModels of the generic collection screens, whose constructors are internal, for the SDK in the
 * umbrella module. Hidden from Objective-C and Swift so that the domain ports it takes stay out of the exported API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class CollectionViewModelFactory(private val reads: CollectionReads, private val writes: CollectionWrites) {
    /**
     * One new ViewModel per call; the caller owns it (see [ScreenViewModel]). The database is named by its canonical
     * [databaseKey] or by its [databaseId]. The collection shows everything of it, except that
     * - [areaId] narrows it to the items of that area,
     * - [relationKey] with [relatedItemId] to the items whose relation holds that item,
     * - [filterJson] to the items a filter selects (the filter of an item's related collection).
     * The first of these that is given applies.
     */
    fun collectionViewModel(
        databaseKey: String?,
        databaseId: String?,
        areaId: String?,
        relationKey: String?,
        relatedItemId: String?,
        filterJson: String?,
    ): CollectionViewModel {
        val scope = when {
            areaId != null -> CollectionScope.Area(areaId)
            relationKey != null && relatedItemId != null -> CollectionScope.Related(relationKey, relatedItemId)
            filterJson != null -> CollectionScope.Matching(FilterTree(filterJson))
            else -> CollectionScope.Everything
        }
        return CollectionViewModel(CollectionConfig(databaseKey, databaseId, scope), OpenCollection(reads), reads, writes)
    }

    /** One new ViewModel per call; the caller owns it. [databaseKeyHint] is the key of the item's database, if known. */
    fun itemViewModel(itemId: String, databaseKeyHint: String?): ItemViewModel =
        ItemViewModel(itemId, databaseKeyHint, LoadItemDetail(reads), FindRelationTargets(reads), reads, writes)
}
