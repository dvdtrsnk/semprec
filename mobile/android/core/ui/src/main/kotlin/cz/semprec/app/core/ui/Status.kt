package cz.semprec.app.core.ui

/** What [StatusView] shows in place of a screen's content. */
sealed interface Status {
    /** The content is being loaded. */
    data object Loading : Status

    /** There is nothing to show; [message] says why. */
    data class Empty(val message: String) : Status

    /** Loading failed; [message] says what went wrong and [onRetry] loads again. */
    data class Error(val message: String, val onRetry: () -> Unit) : Status
}
