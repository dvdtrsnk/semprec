package cz.semprec.app.sdk

import cz.semprec.app.data.AuthenticatedApi
import cz.semprec.app.data.HttpSleepRepository
import cz.semprec.app.presentation.SleepViewModel
import cz.semprec.app.presentation.SleepViewModelFactory

/** The sleep part of [HomeSDK]: plans, night exceptions and settings. */
class SleepSDK internal constructor(api: AuthenticatedApi) {
    private val viewModels = SleepViewModelFactory(HttpSleepRepository(api))

    /** The sleep sheet for the evening [night] (`YYYY-MM-DD`, or `null`); [startOnNight] opens it on that night. */
    fun sleepViewModel(night: String?, startOnNight: Boolean): SleepViewModel =
        viewModels.sleepViewModel(night, startOnNight)
}
