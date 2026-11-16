package cz.semprec.app.sdk

import cz.semprec.app.core.AudioPlayer
import cz.semprec.app.core.AudioRecorder
import cz.semprec.app.core.CapturedAudio
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.PlaybackSource
import cz.semprec.app.core.PlayerListener
import cz.semprec.app.presentation.MeetingPhase
import cz.semprec.app.presentation.RecorderAction
import cz.semprec.app.presentation.RecorderPhase
import cz.semprec.app.presentation.RecorderProblem
import cz.semprec.app.presentation.RecordingsPhase
import cz.semprec.app.presentation.TranscriptPhase
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

private class MuteRecorder : AudioRecorder {
    var asked = 0

    override fun requestPermission(answer: (Boolean) -> Unit) {
        asked += 1
        answer(true)
    }

    override fun start(): Boolean = false

    override fun pause() = Unit

    override fun resume() = Unit

    override fun stop(): CapturedAudio? = null

    override fun cancel() = Unit

    override fun delete(audio: CapturedAudio) = Unit

    override fun elapsedSeconds(): Double = 0.0

    override fun level(): Float = 0f

    override fun importFile(path: String): CapturedAudio? = null
}

private class SilentPlayer : AudioPlayer {
    var released = 0

    override fun prepare(source: PlaybackSource, listener: PlayerListener) = Unit

    override fun play() = Unit

    override fun pause() = Unit

    override fun seekTo(seconds: Double) = Unit

    override fun setRate(rate: Float) = Unit

    override fun release() {
        released += 1
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class RecordingsSDKTest {
    private val dispatcher = StandardTestDispatcher()

    @BeforeTest fun installMain() = Dispatchers.setMain(dispatcher)

    @AfterTest fun removeMain() = Dispatchers.resetMain()

    @Test fun `every call returns a new ViewModel that its caller owns`() = runTest(dispatcher) {
        val sdk = HomeSDK().recordings
        val first = sdk.recordingsViewModel()
        val second = sdk.recordingsViewModel()
        assertNotSame(first, second)
        first.close()
        assertTrue(first.isClosed)
        assertFalse(second.isClosed)
        second.close()
        for (made in listOf(sdk.recorderViewModel(null), sdk.transcriptViewModel("t"), sdk.meetingViewModel("e"))) {
            assertFalse(made.isClosed)
            made.close()
            assertTrue(made.isClosed)
        }
    }

    @Test fun `without a signed in session every screen is unauthorized`() = runTest(dispatcher) {
        val sdk = HomeSDK().recordings
        val list = sdk.recordingsViewModel()
        val transcript = sdk.transcriptViewModel("t")
        val meeting = sdk.meetingViewModel("e")
        runCurrent()
        assertEquals(RecordingsPhase.ERROR, list.state.value.phase)
        assertEquals(FailureKind.UNAUTHORIZED, list.state.value.failure)
        assertEquals(TranscriptPhase.ERROR, transcript.state.value.phase)
        assertEquals(MeetingPhase.ERROR, meeting.state.value.phase)
        list.close()
        transcript.close()
        meeting.close()
    }

    @Test fun `the recorder uses the microphone the SDK was given`() = runTest(dispatcher) {
        val recorder = MuteRecorder()
        val recorderModel = HomeSDK(recorder = recorder).recordings.recorderViewModel("e")
        recorderModel.onAction(RecorderAction.Start)
        assertEquals(1, recorder.asked)
        assertEquals(RecorderPhase.FAILED, recorderModel.state.value.phase)
        assertEquals(RecorderProblem.START_FAILED, recorderModel.state.value.problem)
        recorderModel.close()
    }

    @Test fun `without a microphone the default recorder refuses and the default player fails`() = runTest(dispatcher) {
        val recorderModel = HomeSDK().recordings.recorderViewModel(null)
        recorderModel.onAction(RecorderAction.Start)
        assertEquals(RecorderProblem.PERMISSION_DENIED, recorderModel.state.value.problem)
        recorderModel.close()
    }

    @Test fun `the transcript releases the player it was given when it is closed`() = runTest(dispatcher) {
        val player = SilentPlayer()
        val transcript = HomeSDK(player = player).recordings.transcriptViewModel("t")
        runCurrent()
        transcript.close()
        runCurrent()
        assertEquals(1, player.released)
    }
}
