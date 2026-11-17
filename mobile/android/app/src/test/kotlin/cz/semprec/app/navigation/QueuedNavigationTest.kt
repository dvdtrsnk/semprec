package cz.semprec.app.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class QueuedNavigationTest {
    @Test
    fun `every command reads back as itself`() {
        val commands = listOf(
            NavigationCommand.Detail("item-1"),
            NavigationCommand.Detail("detail:with|separators"),
            NavigationCommand.Detail("null"),
            NavigationCommand.Detail("a/b?c=%20 d&e#f"),
            NavigationCommand.Detail(""),
            NavigationCommand.CloseDetail,
            NavigationCommand.About,
        )
        commands.forEachIndexed { index, command ->
            val queued = QueuedNavigation(index.toLong() + 1, command)
            assertEquals(queued, decodeQueued(queued.encode()))
        }
    }

    @Test
    fun `an unreadable saved command is dropped`() {
        listOf("", "about", "1|", "1|unknown", "x|about", "|about").forEach { saved ->
            assertNull(saved, decodeQueued(saved))
        }
    }
}
