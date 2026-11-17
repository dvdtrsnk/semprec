package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.InboxCapture
import cz.semprec.app.domain.InboxCaptureFile
import cz.semprec.app.domain.InboxCaptureRepository
import cz.semprec.app.domain.InboxCaptureSource
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

/**
 * Writes something down into the Inbox from the diary: a text, a type and a file. The bytes of the attached file stay
 * here, out of the state; a capture with neither text nor file is not sent, and nothing is sent twice at once.
 */
class InboxCaptureViewModel internal constructor(
    private val repository: InboxCaptureRepository,
) : ScreenViewModel<InboxCaptureState, InboxCaptureAction, InboxCaptureEffect>(InboxCaptureState()) {
    private var file: InboxCaptureFile? = null
    private var typesJob: Job? = null
    private var sendJob: Job? = null

    override fun onAction(action: InboxCaptureAction) {
        if (isClosed) return
        when (action) {
            InboxCaptureAction.LoadTypes -> loadTypes()
            is InboxCaptureAction.PickType -> pickType(action.typeId)
            is InboxCaptureAction.Attach -> attach(action)
            InboxCaptureAction.RemoveAttachment -> removeAttachment()
            is InboxCaptureAction.Submit -> submit(action)
            InboxCaptureAction.DismissFailure -> update { it.copy(failure = null) }
        }
    }

    private fun loadTypes() {
        val phase = state.value.typesPhase
        if (phase == InboxCapturePhase.LOADING || phase == InboxCapturePhase.READY) return
        update { it.copy(typesPhase = InboxCapturePhase.LOADING) }
        typesJob = viewModelScope.launch {
            val loaded = answer { repository.types() }
            ensureActive()
            when (loaded) {
                is Answer.Done -> update { state ->
                    state.copy(
                        typesPhase = InboxCapturePhase.READY,
                        types = loaded.value.map { InboxCaptureTypeState(it.id, it.label, it.emoji) },
                    )
                }
                is Answer.Rejected -> update { it.copy(typesPhase = InboxCapturePhase.FAILED) }
            }
        }
    }

    private fun pickType(typeId: String?) {
        if (typeId == null || state.value.types.any { it.id == typeId }) update { it.copy(typeId = typeId) }
    }

    private fun attach(action: InboxCaptureAction.Attach) {
        val bytes = decode(action.base64)
        if (bytes == null) {
            update { it.copy(failure = Failed(FailureKind.INVALID_DATA)) }
            return
        }
        file = InboxCaptureFile(action.filename, action.mimeType, bytes, action.source.domain())
        update { it.copy(attachment = InboxCaptureAttachmentState(action.filename, action.mimeType, bytes.size)) }
    }

    private fun removeAttachment() {
        file = null
        update { it.copy(attachment = null) }
    }

    private fun submit(action: InboxCaptureAction.Submit) {
        val day = CalendarDay.parse(action.day)
        val attached = file
        val blank = action.text.isBlank() && attached == null
        if (day == null || blank || state.value.sending) return
        val capture = InboxCapture(action.text.trim(), day, action.time, state.value.typeId, attached)
        update { it.copy(sending = true, failure = null) }
        sendJob = viewModelScope.launch {
            val sent = answer { repository.capture(capture) }
            ensureActive()
            when (sent) {
                is Answer.Done -> {
                    file = null
                    update { it.copy(sending = false, attachment = null, typeId = null) }
                    emit(InboxCaptureEffect.Captured)
                }
                is Answer.Rejected -> update { it.copy(sending = false, failure = Failed(sent.kind)) }
            }
        }
    }

    @OptIn(ExperimentalEncodingApi::class)
    private fun decode(base64: String): ByteArray? = try {
        Base64.decode(base64)
    } catch (_: IllegalArgumentException) {
        null
    }
}

private fun InboxCaptureAttachmentSource.domain(): InboxCaptureSource = when (this) {
    InboxCaptureAttachmentSource.CAMERA -> InboxCaptureSource.CAMERA
    InboxCaptureAttachmentSource.PHOTO_LIBRARY -> InboxCaptureSource.PHOTO_LIBRARY
    InboxCaptureAttachmentSource.FILES -> InboxCaptureSource.FILES
}
