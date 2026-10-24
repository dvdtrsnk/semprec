package cz.semprec.app.navigation

/** A navigation request of a feature router, queued until the scene runs it. */
sealed interface NavigationCommand {
    data class Detail(val id: String) : NavigationCommand
    data object CloseDetail : NavigationCommand
    data object About : NavigationCommand
}

private const val DETAIL_PREFIX = "detail:"

/** The saved form of the command; [decodeCommand] reads it back. */
internal fun NavigationCommand.encode(): String = when (this) {
    is NavigationCommand.Detail -> DETAIL_PREFIX + id
    NavigationCommand.CloseDetail -> "closeDetail"
    NavigationCommand.About -> "about"
}

/** Reads back what [encode] saved: the command, or null when [value] is no saved command; the caller drops it. */
internal fun decodeCommand(value: String): NavigationCommand? = when {
    value.startsWith(DETAIL_PREFIX) -> NavigationCommand.Detail(value.removePrefix(DETAIL_PREFIX))
    else -> PLAIN_COMMANDS[value]
}

private val PLAIN_COMMANDS: Map<String, NavigationCommand> =
    listOf(NavigationCommand.CloseDetail, NavigationCommand.About).associateBy { it.encode() }
