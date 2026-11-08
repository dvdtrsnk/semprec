package cz.semprec.app.domain

/** A content-free item. Native code renders its title from [ordinal] through localized resources. */
data class PlaceholderItem(val id: String, val ordinal: Int)
