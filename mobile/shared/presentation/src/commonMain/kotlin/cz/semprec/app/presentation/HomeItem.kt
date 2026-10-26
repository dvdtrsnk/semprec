package cz.semprec.app.presentation

import cz.semprec.app.domain.PlaceholderItem

/** One placeholder item on the Home and Detail screens. Native code renders its title from [ordinal]. */
data class HomeItem(val id: String, val ordinal: Int)

internal fun PlaceholderItem.toHomeItem() = HomeItem(id, ordinal)
