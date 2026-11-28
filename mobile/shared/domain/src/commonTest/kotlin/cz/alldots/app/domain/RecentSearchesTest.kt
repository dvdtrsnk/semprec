package cz.alldots.app.domain

import kotlin.test.Test
import kotlin.test.assertEquals

class RecentSearchesTest {
    private val recents = InMemoryRecentSearches()
    private val remember = RememberRecentSearch(recents)

    @Test fun `the most recent search comes first and an equal one moves up without marks or case`() {
        remember("faktura")
        remember("Půlmaraton")
        remember("FAKTURA")

        assertEquals(listOf("FAKTURA", "Půlmaraton"), recents.list())

        remember("pulmaraton")

        assertEquals(listOf("pulmaraton", "FAKTURA"), recents.list())
    }

    @Test fun `only the five latest are kept`() {
        (1..7).forEach { remember("q$it") }

        assertEquals(listOf("q7", "q6", "q5", "q4", "q3"), recents.list())
    }

    @Test fun `a blank search is not remembered and the text is trimmed`() {
        remember("   ")
        remember("  koupelna ")

        assertEquals(listOf("koupelna"), recents.list())
    }

    @Test fun `folding drops the marks of the letters of Czech and keeps the rest`() {
        assertEquals("zlutoucky kun 12", foldForSearch(" Žluťoučký Kůň 12 "))
        val marked = "áàâäãåčćďéèêëěíìîïňńóòôöõřšśťúùûüůýÿžźż"
        assertEquals("aaaaaaccdeeeeeiiiinnooooorsstuuuuuyyzzz", foldForSearch(marked))
    }
}
