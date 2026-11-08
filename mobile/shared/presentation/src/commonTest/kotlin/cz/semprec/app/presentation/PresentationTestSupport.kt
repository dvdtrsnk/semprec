package cz.semprec.app.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.LoadPlaceholderItem
import cz.semprec.app.domain.LoadPlaceholderItems
import cz.semprec.app.domain.PlaceholderItem
import cz.semprec.app.domain.PlaceholderRepository
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import kotlin.test.AfterTest
import kotlin.test.BeforeTest

/** Scripted repository: each call takes the next behavior, then repeats the last one. */
class FakeRepository(vararg behaviors: Behavior) : PlaceholderRepository {
    sealed interface Behavior {
        data class Content(val items: List<PlaceholderItem>) : Behavior
        data object Failure : Behavior
        data object Crash : Behavior
        data object Never : Behavior

        /**
         * Ignores cancellation: waits for [gate] even after the caller was cancelled, then answers as [then].
         * Models a data layer that completes late, such as work in `withContext(NonCancellable)`.
         */
        class Late(val gate: CompletableDeferred<Unit>, val then: Behavior) : Behavior
    }

    private val script = behaviors.toList()
    var calls = 0
        private set
    var cancellations = 0
        private set

    /** How many [Behavior.Late] calls have returned their answer to the caller. */
    var lateAnswers = 0
        private set

    override suspend fun items(): RepositoryResult<List<PlaceholderItem>> = respond { it }

    override suspend fun item(id: String): RepositoryResult<PlaceholderItem?> =
        respond { items -> items.firstOrNull { it.id == id } }

    private suspend fun <T> respond(content: (List<PlaceholderItem>) -> T): RepositoryResult<T> {
        val behavior = script[minOf(calls, script.lastIndex)]
        calls += 1
        return answer(behavior, content)
    }

    private suspend fun <T> answer(behavior: Behavior, content: (List<PlaceholderItem>) -> T): RepositoryResult<T> =
        when (behavior) {
            is Behavior.Content -> RepositoryResult.Content(content(behavior.items))
            Behavior.Failure -> RepositoryResult.Failure(FailureKind.UNAVAILABLE)
            Behavior.Crash -> error("unexpected")
            Behavior.Never -> try {
                awaitCancellation()
            } finally {
                cancellations += 1
            }
            is Behavior.Late -> {
                withContext(NonCancellable) { behavior.gate.await() }
                answer(behavior.then, content).also { lateAnswers += 1 }
            }
        }
}

/** Deliberately out of order: the use case sorts by ordinal. */
val catalog = FakeRepository.Behavior.Content(listOf(PlaceholderItem("item-2", 2), PlaceholderItem("item-1", 1)))

fun factory(repository: FakeRepository) =
    HomeViewModelFactory(LoadPlaceholderItems(repository), LoadPlaceholderItem(repository))

/**
 * Creates a ViewModel through [ViewModelProvider] into this store, the way an Android owner holds it, so that
 * [ViewModelStore.clear] ends it as Android does, without `close()`.
 */
inline fun <reified VM : ViewModel> ViewModelStore.provide(crossinline create: () -> VM): VM =
    ViewModelProvider.create(this, viewModelFactory { initializer { create() } })[VM::class]

@OptIn(ExperimentalCoroutinesApi::class)
abstract class MainDispatcherTest {
    protected val dispatcher: TestDispatcher = StandardTestDispatcher()
    @BeforeTest fun installMain() = Dispatchers.setMain(dispatcher)
    @AfterTest fun removeMain() = Dispatchers.resetMain()
}
