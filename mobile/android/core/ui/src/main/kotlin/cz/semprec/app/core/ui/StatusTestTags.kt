package cz.semprec.app.core.ui

/** Test tags of [StatusView]; UI tests find its nodes by them, UIAutomator sees them as resource ids. */
object StatusTestTags {
    const val LOADING = "state.loading"
    const val MESSAGE = "state.message"
    const val RETRY = "state.retry"
}
