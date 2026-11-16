package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.domain.ACCOUNT_LOCALES
import cz.semprec.app.domain.AccountRepository
import cz.semprec.app.domain.AccountSummary
import cz.semprec.app.domain.AuthRepository
import cz.semprec.app.domain.RequestPasswordReset
import cz.semprec.app.domain.SessionStatus
import cz.semprec.app.domain.SignOut
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * The profile: who is signed in, the figures of the rows below it, the language, the password-reset link and the
 * sign-out. A row raises its page as the effect. A failed summary leaves the identity and the sign-out usable.
 */
class ProfileViewModel internal constructor(
    private val account: AccountRepository,
    private val auth: AuthRepository,
    private val requestReset: RequestPasswordReset,
    private val signOut: SignOut,
) : ScreenViewModel<ProfileState, ProfileAction, ProfileEffect>(identity(auth)) {
    private var loadJob: Job? = null

    init {
        load()
    }

    override fun onAction(action: ProfileAction) {
        if (isClosed) return
        when (action) {
            ProfileAction.Retry -> load()
            is ProfileAction.Open -> emit(ProfileEffect.Open(action.page))
            is ProfileAction.ChangeLocale -> changeLocale(action.locale)
            ProfileAction.RequestPasswordReset -> sendReset()
            ProfileAction.SignOut -> viewModelScope.launch { signOut() }
            ProfileAction.DismissFailure -> update { it.copy(writeFailure = null) }
        }
    }

    private fun load() {
        loadJob?.cancel()
        update { it.copy(phase = ProfilePhase.LOADING, failure = null) }
        loadJob = viewModelScope.launch {
            val result = answer { account.summary() }
            ensureActive()
            update {
                when (result) {
                    is Answer.Done -> it.copy(phase = ProfilePhase.CONTENT, figures = result.value.toFigures())
                    is Answer.Rejected -> it.copy(phase = ProfilePhase.ERROR, failure = result.kind)
                }
            }
        }
    }

    private fun changeLocale(locale: String) {
        val current = state.value
        if (locale !in ACCOUNT_LOCALES || locale == current.locale || current.localeSaving) return
        update { it.copy(localeSaving = true, writeFailure = null) }
        viewModelScope.launch {
            val result = answer { account.changeLocale(locale) }
            ensureActive()
            update {
                when (result) {
                    is Answer.Done -> it.copy(localeSaving = false, locale = locale)
                    is Answer.Rejected -> it.copy(localeSaving = false, writeFailure = Failed(result.kind))
                }
            }
        }
    }

    private fun sendReset() {
        val current = state.value
        val email = current.email
        val server = current.serverUrl
        if (email == null || server == null || current.resetPhase == ProfileResetPhase.SENDING) return
        update { it.copy(resetPhase = ProfileResetPhase.SENDING) }
        viewModelScope.launch {
            val result = answer { requestReset(server, email) }
            ensureActive()
            val next = if (result is Answer.Done) ProfileResetPhase.SENT else ProfileResetPhase.FAILED
            update { it.copy(resetPhase = next) }
        }
    }
}

private fun identity(auth: AuthRepository): ProfileState {
    val session = (auth.status.value as? SessionStatus.SignedIn)?.session
    return ProfileState(
        email = session?.user?.email,
        serverUrl = session?.serverUrl,
        locale = session?.user?.locale,
        locales = ACCOUNT_LOCALES,
    )
}

private fun AccountSummary.toFigures() = ProfileFigures(
    activeSessions = activeSessions,
    mailAccountCount = mailAccountCount,
    mailAccountsNeedingReauth = mailAccountsNeedingReauth,
    trashCount = trashItems + trashDatabases,
    problemCount = problemCount,
    aiCostMonthUsd = aiCostMonthUsd,
)
