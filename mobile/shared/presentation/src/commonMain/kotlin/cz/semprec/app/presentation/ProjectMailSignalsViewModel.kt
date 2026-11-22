package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.MailSignalField
import cz.semprec.app.domain.AddMailSignal
import cz.semprec.app.domain.MAX_MAIL_SIGNAL_APPLY_THREADS
import cz.semprec.app.domain.MailSignalAddition
import cz.semprec.app.domain.MailSignalAssignment
import cz.semprec.app.domain.MailSignalPreview
import cz.semprec.app.domain.MailSignalSet
import cz.semprec.app.domain.MailSignalsOutcome
import cz.semprec.app.domain.ProjectMailSignals
import cz.semprec.app.domain.ProjectMailSignalsRepository
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/** How long the preview waits after the last change of the lists before it asks the server. */
internal const val MAIL_SIGNALS_PREVIEW_DELAY_MILLIS = 400L

/**
 * The mail signals of one project: its people (read only), its own domains, addresses and keywords, and a preview of
 * the open threads they match. Every change of the lists asks for a new preview of the lists on screen once the person
 * pauses; a newer preview supersedes an older one. Save replaces the saved signals and previews them again. Assign asks
 * for a fresh preview of the saved signals and gives the project to the threads it lists, because the server assigns
 * only threads its saved signals match; then it previews again.
 */
class ProjectMailSignalsViewModel internal constructor(
    private val projectId: String,
    private val repository: ProjectMailSignalsRepository,
    private val addSignal: AddMailSignal,
) : ScreenViewModel<ProjectMailSignalsState, ProjectMailSignalsAction, Nothing>(ProjectMailSignalsState()) {
    private var saved = MailSignalSet()
    private var draft = MailSignalSet()
    private var loadJob: Job? = null
    private var previewJob: Job? = null
    private var saveJob: Job? = null
    private var assignJob: Job? = null

    init {
        load()
    }

    override fun onAction(action: ProjectMailSignalsAction) {
        if (isClosed) return
        when (action) {
            ProjectMailSignalsAction.Retry -> load()
            is ProjectMailSignalsAction.EditInput ->
                change { it.withInput(action.field, action.text).valid(action.field) }
            is ProjectMailSignalsAction.Add -> add(action.field)
            is ProjectMailSignalsAction.Remove -> remove(action.field, action.value)
            ProjectMailSignalsAction.Save -> save()
            ProjectMailSignalsAction.Assign -> assign()
            ProjectMailSignalsAction.RetryPreview -> if (isReady()) startPreview(wait = false)
            ProjectMailSignalsAction.DismissAssignment -> change { it.copy(assignment = null) }
            ProjectMailSignalsAction.DismissFailure -> change { it.copy(saveFailure = null, assignFailure = null) }
        }
    }

    private fun load() {
        listOf(loadJob, previewJob, saveJob, assignJob).forEach { it?.cancel() }
        saved = MailSignalSet()
        draft = saved
        update { ProjectMailSignalsState() }
        loadJob = viewModelScope.launch {
            val result = answer { repository.signals(projectId) }
            currentCoroutineContext().ensureActive()
            when (result) {
                is Answer.Done -> {
                    saved = result.value.signals
                    draft = saved
                    change { it.copy(phase = ProjectMailSignalsPhase.READY).withPeople(result.value) }
                    startPreview(wait = false)
                }
                is Answer.Rejected -> change { it.copy(phase = ProjectMailSignalsPhase.ERROR, failure = result.kind) }
            }
        }
    }

    private fun add(field: MailSignalField) {
        if (!isReady()) return
        when (val addition = addSignal(draft, field, state.value.input(field))) {
            is MailSignalAddition.Added -> {
                draft = addition.signals
                change { it.withInput(field, "").valid(field) }
                startPreview(wait = true)
            }
            MailSignalAddition.AlreadyThere -> change { it.withInput(field, "").valid(field) }
            MailSignalAddition.Blank -> Unit
            MailSignalAddition.Invalid -> change { it.copy(invalidField = field) }
        }
    }

    private fun remove(field: MailSignalField, value: String) {
        val list = draft.values(field)
        if (!isReady() || value !in list) return
        draft = draft.with(field, list - value)
        change { it.valid(field) }
        startPreview(wait = true)
    }

    /** Previews the lists on screen, or the saved signals when they are the same, so that ids match the saved ones. */
    private fun startPreview(wait: Boolean) {
        previewJob?.cancel()
        change { it.copy(preview = it.preview.copy(phase = MailSignalsPreviewPhase.LOADING, failure = null)) }
        val sending = draft.takeIf { it != saved }
        previewJob = viewModelScope.launch {
            if (wait) delay(MAIL_SIGNALS_PREVIEW_DELAY_MILLIS)
            val result = answer { repository.preview(projectId, sending) }
            currentCoroutineContext().ensureActive()
            change { it.withPreview(result) }
        }
    }

    private fun save() {
        if (!state.value.canSave) return
        val sending = draft
        change { it.copy(saving = true, saveFailure = null, invalidField = null) }
        saveJob = viewModelScope.launch {
            val result = answer { repository.save(projectId, sending) }
            currentCoroutineContext().ensureActive()
            val outcome = (result as? Answer.Done)?.value
            when {
                outcome is MailSignalsOutcome.Done -> {
                    saved = outcome.value.signals
                    if (draft == sending) draft = saved
                    change { it.copy(saving = false).withPeople(outcome.value) }
                    startPreview(wait = false)
                }
                outcome is MailSignalsOutcome.Invalid ->
                    change { it.copy(saving = false, invalidField = outcome.field) }
                else -> change { it.copy(saving = false, saveFailure = Failed((result as? Answer.Rejected)?.kind)) }
            }
        }
    }

    private fun assign() {
        if (!state.value.canAssign) return
        change { it.copy(assigning = true, assignFailure = null, assignment = null) }
        assignJob = viewModelScope.launch {
            val fresh = answer { repository.preview(projectId, null) }
            currentCoroutineContext().ensureActive()
            val threadIds = fresh.preview()?.threads?.map { it.threadId }?.take(MAX_MAIL_SIGNAL_APPLY_THREADS)
            val result = when {
                threadIds == null -> Answer.Rejected(fresh.failure())
                threadIds.isEmpty() -> Answer.Done(MailSignalAssignment(assigned = 0, skipped = 0))
                else -> answer { repository.apply(projectId, threadIds) }
            }
            currentCoroutineContext().ensureActive()
            change {
                when (result) {
                    is Answer.Done -> it.copy(
                        assigning = false,
                        assignment = MailSignalsAssignment(result.value.assigned, result.value.skipped),
                    )
                    is Answer.Rejected -> it.copy(assigning = false, assignFailure = Failed(result.kind))
                }
            }
            startPreview(wait = false)
        }
    }

    private fun isReady() = state.value.phase == ProjectMailSignalsPhase.READY

    /** Applies [transform] and then derives what follows from the lists: what is on screen, unsaved, Save, Assign. */
    private fun change(transform: (ProjectMailSignalsState) -> ProjectMailSignalsState) = update { current ->
        val next = transform(current)
        val ready = next.phase == ProjectMailSignalsPhase.READY
        val unsaved = draft != saved
        val idle = !next.saving && !next.assigning
        val previewed = next.preview.phase == MailSignalsPreviewPhase.READY && next.preview.threads.isNotEmpty()
        next.copy(
            domains = draft.domains,
            addresses = draft.addresses,
            keywords = draft.keywords,
            unsaved = unsaved,
            canSave = ready && unsaved && idle,
            canAssign = ready && !unsaved && idle && previewed,
        )
    }
}

private fun ProjectMailSignalsState.input(field: MailSignalField) = when (field) {
    MailSignalField.DOMAINS -> domainInput
    MailSignalField.ADDRESSES -> addressInput
    MailSignalField.KEYWORDS -> keywordInput
}

private fun ProjectMailSignalsState.withInput(field: MailSignalField, text: String) = when (field) {
    MailSignalField.DOMAINS -> copy(domainInput = text)
    MailSignalField.ADDRESSES -> copy(addressInput = text)
    MailSignalField.KEYWORDS -> copy(keywordInput = text)
}

/** Clears the refusal of [field], which the person is changing. */
private fun ProjectMailSignalsState.valid(field: MailSignalField) =
    if (invalidField == field) copy(invalidField = null) else this

private fun ProjectMailSignalsState.withPeople(signals: ProjectMailSignals) =
    copy(people = signals.people.map { MailSignalPersonItem(it.personId, it.name, it.address) })

private fun ProjectMailSignalsState.withPreview(result: Answer<MailSignalsOutcome<MailSignalPreview>>) =
    when (val outcome = (result as? Answer.Done)?.value) {
        is MailSignalsOutcome.Done -> copy(
            preview = MailSignalsPreviewState(
                phase = MailSignalsPreviewPhase.READY,
                total = outcome.value.total,
                alreadyAssigned = outcome.value.alreadyAssigned,
                threads = outcome.value.threads.map {
                    MailSignalThreadItem(it.threadId, it.subject, it.senderName, it.senderAddress, it.lastMessageAt)
                },
            ),
        )
        is MailSignalsOutcome.Invalid -> copy(
            invalidField = outcome.field,
            preview = preview.copy(phase = MailSignalsPreviewPhase.ERROR, failure = FailureKind.REJECTED),
        )
        null -> copy(
            preview = preview.copy(phase = MailSignalsPreviewPhase.ERROR, failure = (result as? Answer.Rejected)?.kind),
        )
    }

private fun Answer<MailSignalsOutcome<MailSignalPreview>>.preview(): MailSignalPreview? =
    ((this as? Answer.Done)?.value as? MailSignalsOutcome.Done)?.value

/** Why a preview of the saved signals gave no threads; the saved signals are never refused as a list. */
private fun Answer<MailSignalsOutcome<MailSignalPreview>>.failure(): FailureKind? = when (this) {
    is Answer.Done -> FailureKind.REJECTED
    is Answer.Rejected -> kind
}
