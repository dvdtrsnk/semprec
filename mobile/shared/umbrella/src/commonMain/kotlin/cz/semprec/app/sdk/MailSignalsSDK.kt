package cz.semprec.app.sdk

import cz.semprec.app.data.AuthenticatedApi
import cz.semprec.app.data.HttpProjectMailSignalsRepository
import cz.semprec.app.presentation.ProjectMailSignalsViewModel
import cz.semprec.app.presentation.ProjectMailSignalsViewModelFactory

/** The mail signals of projects, of [HomeSDK]. Every call creates a new ViewModel that the caller owns. */
class MailSignalsSDK internal constructor(api: AuthenticatedApi) {
    private val viewModels = ProjectMailSignalsViewModelFactory(HttpProjectMailSignalsRepository(api))

    fun projectMailSignalsViewModel(projectId: String): ProjectMailSignalsViewModel = viewModels.viewModel(projectId)
}
