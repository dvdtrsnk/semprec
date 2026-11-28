package cz.alldots.app.presentation

import cz.alldots.app.domain.CollectionReads
import cz.alldots.app.domain.CollectionWrites
import cz.alldots.app.domain.FindRelationTargets
import cz.alldots.app.domain.LoadItemDetail
import cz.alldots.app.domain.OpenCollection
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the ViewModels of the generic collection screens, whose constructors are internal, for the SDK in the
 * umbrella module. Hidden from Objective-C and Swift so that the domain ports it takes stay out of the exported API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class CollectionViewModelFactory(
    private val reads: CollectionReads,
    private val writes: CollectionWrites,
    private val changes: Flow<Unit> = emptyFlow(),
) {
    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun collectionViewModel(target: CollectionTarget): CollectionViewModel =
        CollectionViewModel(target.toConfig(), OpenCollection(reads), reads, writes, changes)

    /** One new ViewModel per call; the caller owns it. [databaseKeyHint] is the key of the item's database. */
    fun itemViewModel(itemId: String, databaseKeyHint: String?): ItemViewModel =
        ItemViewModel(
            itemId,
            databaseKeyHint,
            LoadItemDetail(reads),
            FindRelationTargets(reads),
            reads,
            writes,
            changes,
        )
}
