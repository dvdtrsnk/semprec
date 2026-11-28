package cz.alldots.app.sdk

import cz.alldots.app.core.FailureKind
import cz.alldots.app.presentation.CollectionPhase
import cz.alldots.app.presentation.CollectionTarget
import cz.alldots.app.presentation.ItemPhase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotSame
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class CollectionSDKTest {
    private val dispatcher = StandardTestDispatcher()
    @BeforeTest fun installMain() = Dispatchers.setMain(dispatcher)
    @AfterTest fun removeMain() = Dispatchers.resetMain()

    @Test fun `every call returns a new collection and item ViewModel that its caller owns`() = runTest(dispatcher) {
        val sdk = HomeSDK()
        val collections = sdk.collections.collectionViewModel(CollectionTarget.Whole("projects", null)) to
            sdk.collections.collectionViewModel(CollectionTarget.Whole("projects", null))
        val items = sdk.collections.itemViewModel("i1", "projects") to sdk.collections.itemViewModel("i1", "projects")
        listOf(collections, items).forEach { (first, second) ->
            assertNotSame(first, second)
            first.close()
            assertTrue(first.isClosed)
            assertFalse(second.isClosed)
            second.close()
        }
    }

    @Test fun `without a signed in session a collection and an item are unauthorized`() = runTest(dispatcher) {
        val sdk = HomeSDK()
        val collection = sdk.collections.collectionViewModel(CollectionTarget.Whole(null, "db-1"))
        val item = sdk.collections.itemViewModel("i1", null)
        runCurrent()
        assertEquals(CollectionPhase.ERROR, collection.state.value.phase)
        assertEquals(FailureKind.UNAUTHORIZED, collection.state.value.failure)
        assertEquals(ItemPhase.ERROR, item.state.value.phase)
        assertEquals(FailureKind.UNAUTHORIZED, item.state.value.failure)
        collection.close()
        item.close()
    }

    @Test fun `a collection can be narrowed by a relation or by a filter`() = runTest(dispatcher) {
        val sdk = HomeSDK()
        val related = sdk.collections.collectionViewModel(CollectionTarget.OfItem("files", "projects", "p1"))
        val emptyFilter = """{"type":"is_empty"}"""
        val filtered = sdk.collections.collectionViewModel(CollectionTarget.Matching("files", null, emptyFilter))
        runCurrent()
        assertEquals(FailureKind.UNAUTHORIZED, related.state.value.failure)
        assertEquals(FailureKind.UNAUTHORIZED, filtered.state.value.failure)
        related.close()
        filtered.close()
    }
}
