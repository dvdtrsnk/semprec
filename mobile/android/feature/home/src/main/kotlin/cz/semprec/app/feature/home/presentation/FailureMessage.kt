package cz.semprec.app.feature.home.presentation

import androidx.annotation.StringRes
import cz.semprec.app.android.feature.home.R
import cz.semprec.app.core.FailureKind

/** The message for a failed load: [failure] is the expected failure, or `null` for an unexpected one. */
@StringRes
internal fun failureMessage(failure: FailureKind?): Int = when (failure) {
    FailureKind.UNAVAILABLE -> R.string.failure_unavailable
    FailureKind.INVALID_DATA -> R.string.failure_invalidData
    null -> R.string.failure_unexpected
}
