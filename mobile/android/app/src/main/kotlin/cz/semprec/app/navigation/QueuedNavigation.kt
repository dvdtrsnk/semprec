package cz.semprec.app.navigation

/** A command with the sequence number the scene acknowledges it by. */
data class QueuedNavigation(val sequence: Long, val command: NavigationCommand)

private const val SEPARATOR = '|'

/** The saved form `<sequence>|<command>`; [decodeQueued] reads it back. */
internal fun QueuedNavigation.encode(): String = "$sequence$SEPARATOR${command.encode()}"

/** Reads back what [encode] saved: the queued command, or null when its sequence or command cannot be read. */
internal fun decodeQueued(value: String): QueuedNavigation? {
    val sequence = value.substringBefore(SEPARATOR, missingDelimiterValue = "").toLongOrNull()
    val command = decodeCommand(value.substringAfter(SEPARATOR, missingDelimiterValue = ""))
    return if (sequence != null && command != null) QueuedNavigation(sequence, command) else null
}
