package cz.semprec.app.feature.settings

import cz.semprec.app.presentation.SettingsEffect

/** Navigation the Settings feature asks for; the app decides how each destination is presented. */
interface SettingsRouter {
    /** Presents [cz.semprec.app.feature.settings.presentation.screen.about.AboutScreenLayout]. */
    fun showAbout()
}

internal fun SettingsRouter.handle(effect: SettingsEffect) = when (effect) {
    SettingsEffect.ShowAbout -> showAbout()
}
