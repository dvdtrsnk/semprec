package cz.semprec.app.feature.home

/** Test tags of the Home feature; UI tests find its nodes by them, UIAutomator sees them as resource ids. */
object HomeTestTags {
    const val HOME_SCREEN = "home.screen"

    /** Followed by the item id, e.g. `home.item.item-1`. */
    const val HOME_ITEM_PREFIX = "home.item."
    const val DETAIL_SCREEN = "detail.screen"
    const val DETAIL_TITLE = "detail.title"
    const val DETAIL_BACK = "detail.back"
}
