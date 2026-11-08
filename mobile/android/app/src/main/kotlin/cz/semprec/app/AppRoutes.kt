package cz.semprec.app

import kotlinx.serialization.Serializable

/*
 * The destinations of the tab stacks, as type-safe Navigation routes. Navigation encodes each property into the
 * route and decodes it back with the property's type: a non-null String keeps every value as it was, the literal
 * "null" and characters such as '/', '?', '%' or spaces included.
 */

/** The Home list, start of the Home stack. */
@Serializable
data object HomeRoute

/** The detail of the item with [itemId], pushed onto the Home stack. */
@Serializable
data class DetailRoute(val itemId: String)

/** The Settings list, start of the Settings stack. */
@Serializable
data object SettingsRoute
