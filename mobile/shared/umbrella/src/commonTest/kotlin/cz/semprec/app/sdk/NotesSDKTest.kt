package cz.semprec.app.sdk

import cz.semprec.app.core.FailureKind
import cz.semprec.app.presentation.NotesPhase
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
class NotesSDKTest {
    private val dispatcher = StandardTestDispatcher()
    @BeforeTest fun installMain() = Dispatchers.setMain(dispatcher)
    @AfterTest fun removeMain() = Dispatchers.resetMain()

    @Test fun `every call returns a new notes ViewModel that its caller owns`() = runTest(dispatcher) {
        val sdk = HomeSDK()
        val first = sdk.notes.notesViewModel("i1")
        val second = sdk.notes.notesViewModel("i1")
        assertNotSame(first, second)
        first.close()
        assertTrue(first.isClosed)
        assertFalse(second.isClosed)
        second.close()
    }

    @Test fun `without a signed in session the notes are unauthorized`() = runTest(dispatcher) {
        val notes = HomeSDK().notes.notesViewModel("i1")
        runCurrent()
        assertEquals(NotesPhase.ERROR, notes.state.value.phase)
        assertEquals(FailureKind.UNAUTHORIZED, notes.state.value.failure)
        notes.close()
    }
}
