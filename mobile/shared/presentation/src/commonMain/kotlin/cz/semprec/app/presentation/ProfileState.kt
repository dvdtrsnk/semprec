package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind

enum class ProfilePhase { LOADING, CONTENT, ERROR }

/** Where a row of the profile leads. The app decides which screen shows it. */
enum class AccountPage { DEVICES, NOTIFICATIONS, AI_USAGE, TRASH, SEMP_STATUS, INTERNET_ACCOUNTS, APPEARANCE }

/** What the profile asks the app to do: show the screen a row leads to. */
sealed interface ProfileEffect {
    data class Open(val page: AccountPage) : ProfileEffect
}

/** What sending the password-reset link came to. */
enum class ProfileResetPhase { IDLE, SENDING, SENT, FAILED }

/** The figures of the rows of the profile; [mailAccountsNeedingReauth] is how many accounts must sign in again. */
data class ProfileFigures(
    val activeSessions: Int,
    val mailAccountCount: Int,
    val mailAccountsNeedingReauth: Int,
    val trashCount: Int,
    val problemCount: Int,
    val aiCostMonthUsd: Double,
)

/**
 * The profile of the signed-in person. The identity is known without the server; [figures] arrive with the summary,
 * whose failure is [failure] and leaves the identity and the sign-out where they are. [name] is the display name of
 * the account, `null` when it has none. [locale] is the language of the
 * account and [locales] the languages the server offers.
 */
data class ProfileState(
    val phase: ProfilePhase = ProfilePhase.LOADING,
    val failure: FailureKind? = null,
    val email: String? = null,
    val name: String? = null,
    val serverUrl: String? = null,
    val locale: String? = null,
    val locales: List<String> = emptyList(),
    val figures: ProfileFigures? = null,
    val localeSaving: Boolean = false,
    val resetPhase: ProfileResetPhase = ProfileResetPhase.IDLE,
    val writeFailure: Failed? = null,
)
