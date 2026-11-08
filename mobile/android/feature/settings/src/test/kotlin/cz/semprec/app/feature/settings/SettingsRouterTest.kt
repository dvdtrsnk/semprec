package cz.semprec.app.feature.settings

import cz.semprec.app.presentation.SettingsEffect
import org.junit.Assert.assertEquals
import org.junit.Test

class SettingsRouterTest {
    @Test
    fun `show about presents the about destination`() {
        var shown = 0
        val router = object : SettingsRouter {
            override fun showAbout() {
                shown++
            }
        }
        router.handle(SettingsEffect.ShowAbout)
        assertEquals(1, shown)
    }
}
