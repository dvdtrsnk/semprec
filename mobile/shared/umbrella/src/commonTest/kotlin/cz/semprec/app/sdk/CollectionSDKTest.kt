package cz.semprec.app.sdk

import cz.semprec.app.core.FailureKind
import cz.semprec.app.presentation.CollectionPhase
import cz.semprec.app.presentation.CollectionTarget
import cz.semprec.app.presentation.ItemPhase
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
        val collections = sdk.collectionViewModel(CollectionTarget.Whole("projects", null)) to
            sdk.collectionViewModel(CollectionTarget.Whole("projects", null))
        val items = sdk.itemViewModel("i1", "projects") to sdk.itemViewModel("i1", "projects")
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
        val collection = sdk.collectionViewModel(CollectionTarget.Whole(null, "db-1"))
        val item = sdk.itemViewModel("i1", null)
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
        val area = sdk.collectionViewModel(CollectionTarget.OfArea("projects", "a1"))
        val related = sdk.collectionViewModel(CollectionTarget.OfItem("files", "projects", "p1"))
        val filtered = sdk.collectionViewModel(CollectionTarget.Matching("files", null, """{"type":"is_empty"}"""))
        runCurrent()
        assertEquals(FailureKind.UNAUTHORIZED, related.state.value.failure)
        assertEquals(FailureKind.UNAUTHORIZED, filtered.state.value.failure)
        assertEquals(FailureKind.UNAUTHORIZED, area.state.value.failure)
        area.close()
        related.close()
        filtered.close()
    }
}
