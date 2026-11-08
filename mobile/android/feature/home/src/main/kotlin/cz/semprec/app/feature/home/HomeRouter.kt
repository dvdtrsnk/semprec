package cz.semprec.app.feature.home

import cz.semprec.app.presentation.HomeEffect

/** Navigation the Home feature asks for; the app implements it on its own navigation stack. */
interface HomeRouter {
    /** Shows the detail of the item with [id] above the list. */
    fun showDetail(id: String)

    /**
     * Leaves the detail on top for the screen below it. The detail's up button calls it directly: going back is
     * navigation only, and the shared detail screen has no action for it.
     */
    fun closeDetail()
}

internal fun HomeRouter.handle(effect: HomeEffect) = when (effect) {
    is HomeEffect.OpenDetail -> showDetail(effect.id)
}
