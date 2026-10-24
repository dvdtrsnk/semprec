package cz.semprec.app.feature.home

import cz.semprec.app.presentation.HomeEffect
import org.junit.Assert.assertEquals
import org.junit.Test

class HomeRouterTest {
    @Test
    fun `open detail shows the detail of the selected item`() {
        val router = RecordingRouter()
        router.handle(HomeEffect.OpenDetail("item-2"))
        assertEquals(listOf("detail:item-2"), router.events)
    }
}

private class RecordingRouter : HomeRouter {
    val events = mutableListOf<String>()

    override fun showDetail(id: String) {
        events += "detail:$id"
    }

    override fun closeDetail() {
        events += "close"
    }
}
