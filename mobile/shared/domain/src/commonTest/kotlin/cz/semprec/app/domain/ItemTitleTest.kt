package cz.semprec.app.domain

import kotlin.test.Test
import kotlin.test.assertEquals

class ItemTitleTest {
    @Test fun `a title is saved on one line with its words kept apart`() {
        val cases = listOf(
            "Lunch" to "Lunch",
            "  Lunch  " to "Lunch",
            "Lunch\n" to "Lunch",
            "Lunch\nwith Eva" to "Lunch with Eva",
            "Lunch \r\n\n  with Eva" to "Lunch with Eva",
            "Lunch with Eva" to "Lunch with Eva",
            "\n\n" to "",
            "Lunch  with\tEva" to "Lunch  with\tEva",
        )
        cases.forEach { (typed, saved) -> assertEquals(saved, singleLineTitle(typed), "for \"$typed\"") }
    }
}
