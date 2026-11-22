package cz.semprec.app.domain

import cz.semprec.app.core.MailSignalField
import kotlin.test.Test
import kotlin.test.assertEquals

class AddMailSignalTest {
    private val add = AddMailSignal()

    private fun added(field: MailSignalField, value: String, onto: MailSignalSet = MailSignalSet()) =
        MailSignalAddition.Added(onto.with(field, onto.values(field) + value))

    @Test fun `a typed value is normalized as the server keeps it`() {
        val cases = listOf(
            Triple(MailSignalField.DOMAINS, "  Novak.CZ ", "novak.cz"),
            Triple(MailSignalField.DOMAINS, "https://www.novak.cz/kontakt?x=1#a", "novak.cz"),
            Triple(MailSignalField.DOMAINS, "http://user@Mail.Novak.cz:8080/", "mail.novak.cz"),
            Triple(MailSignalField.DOMAINS, "www.novak.cz.", "novak.cz"),
            Triple(MailSignalField.DOMAINS, "pekárna.cz", "pekárna.cz"),
            Triple(MailSignalField.ADDRESSES, "  Petr.Novak@Novak.CZ ", "petr.novak@novak.cz"),
            Triple(MailSignalField.KEYWORDS, "  Faktura   za\tbřezen ", "Faktura za březen"),
            Triple(MailSignalField.KEYWORDS, "2026", "2026"),
        )
        cases.forEach { (field, typed, kept) ->
            assertEquals(added(field, kept), add(MailSignalSet(), field, typed), "$field '$typed'")
        }
    }

    @Test fun `a value the server would refuse is invalid`() {
        val cases = listOf(
            MailSignalField.DOMAINS to "localhost",
            MailSignalField.DOMAINS to "novak .cz",
            MailSignalField.DOMAINS to "-novak.cz",
            MailSignalField.DOMAINS to "https://",
            MailSignalField.DOMAINS to "a".repeat(251) + ".cz",
            MailSignalField.ADDRESSES to "petr",
            MailSignalField.ADDRESSES to "petr@novak@cz",
            MailSignalField.ADDRESSES to "petr novak@novak.cz",
            MailSignalField.ADDRESSES to "petr,novak@novak.cz",
            MailSignalField.KEYWORDS to "--- !",
            MailSignalField.KEYWORDS to "a".repeat(101),
        )
        cases.forEach { (field, typed) ->
            assertEquals(MailSignalAddition.Invalid, add(MailSignalSet(), field, typed), "$field '$typed'")
        }
    }

    @Test fun `nothing but whitespace adds nothing`() {
        MailSignalField.entries.forEach { field ->
            assertEquals(MailSignalAddition.Blank, add(MailSignalSet(), field, " \t "))
        }
    }

    @Test fun `a value already in the list is not added again and a keyword matches whatever its case`() {
        val signals = MailSignalSet(listOf("novak.cz"), listOf("petr@novak.cz"), listOf("Faktura"))
        val cases = listOf(
            MailSignalField.DOMAINS to "WWW.Novak.cz",
            MailSignalField.ADDRESSES to "Petr@Novak.cz",
            MailSignalField.KEYWORDS to "faktura",
        )
        cases.forEach { (field, typed) ->
            assertEquals(MailSignalAddition.AlreadyThere, add(signals, field, typed), "$field '$typed'")
        }
    }

    @Test fun `a new value goes to the end of its list and leaves the others alone`() {
        val signals = MailSignalSet(listOf("novak.cz"), listOf("petr@novak.cz"), listOf("Faktura"))
        assertEquals(
            MailSignalAddition.Added(signals.copy(keywords = listOf("Faktura", "Smlouva"))),
            add(signals, MailSignalField.KEYWORDS, "Smlouva"),
        )
    }

    @Test fun `a full list takes no more values`() {
        val limits =
            mapOf(MailSignalField.DOMAINS to 50, MailSignalField.ADDRESSES to 100, MailSignalField.KEYWORDS to 50)
        limits.forEach { (field, limit) ->
            val almost = MailSignalSet().with(field, (1 until limit).map { value(field, it) })
            val last = value(field, limit)
            assertEquals(added(field, last, almost), add(almost, field, last), "$field at ${limit - 1}")
            val full = almost.with(field, almost.values(field) + last)
            assertEquals(MailSignalAddition.Invalid, add(full, field, value(field, limit + 1)), "$field at $limit")
        }
    }

    private fun value(field: MailSignalField, n: Int) = when (field) {
        MailSignalField.DOMAINS -> "d$n.cz"
        MailSignalField.ADDRESSES -> "a$n@novak.cz"
        MailSignalField.KEYWORDS -> "slovo$n"
    }
}
