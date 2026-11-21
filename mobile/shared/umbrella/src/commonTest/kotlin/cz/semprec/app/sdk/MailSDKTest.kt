package cz.semprec.app.sdk

import cz.semprec.app.core.FailureKind
import cz.semprec.app.presentation.InternetAccountPhase
import cz.semprec.app.presentation.MailComposeStart
import cz.semprec.app.presentation.MailFoldersPhase
import cz.semprec.app.presentation.MailListStart
import cz.semprec.app.presentation.MailThreadPhase
import cz.semprec.app.presentation.MailThreadsPhase
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
class MailSDKTest {
    private val dispatcher = StandardTestDispatcher()
    @BeforeTest fun installMain() = Dispatchers.setMain(dispatcher)
    @AfterTest fun removeMain() = Dispatchers.resetMain()

    @Test fun `every call returns a new mail ViewModel that its caller owns`() = runTest(dispatcher) {
        val mail = HomeSDK().mail
        val pairs = listOf(
            mail.threadsViewModel(MailListStart()) to mail.threadsViewModel(MailListStart()),
            mail.threadViewModel("t1") to mail.threadViewModel("t1"),
            mail.composeViewModel(MailComposeStart.New) to mail.composeViewModel(MailComposeStart.New),
            mail.foldersViewModel() to mail.foldersViewModel(),
            mail.internetAccountsViewModel() to mail.internetAccountsViewModel(),
            mail.internetAccountViewModel("m1") to mail.internetAccountViewModel("m1"),
        )
        pairs.forEach { (first, second) ->
            assertNotSame(first, second)
            first.close()
            assertTrue(first.isClosed)
            assertFalse(second.isClosed)
            second.close()
        }
    }

    @Test fun `without a signed in session every mail screen is unauthorized`() = runTest(dispatcher) {
        val mail = HomeSDK().mail
        val threads = mail.threadsViewModel(MailListStart())
        val thread = mail.threadViewModel("t1")
        val folders = mail.foldersViewModel()
        val account = mail.internetAccountViewModel("m1")
        runCurrent()
        assertEquals(MailThreadsPhase.ERROR, threads.state.value.phase)
        assertEquals(FailureKind.UNAUTHORIZED, threads.state.value.failure)
        assertEquals(MailThreadPhase.ERROR, thread.state.value.phase)
        assertEquals(MailFoldersPhase.ERROR, folders.state.value.phase)
        assertEquals(InternetAccountPhase.ERROR, account.state.value.phase)
        listOf(threads, thread, folders, account).forEach { it.close() }
    }
}
