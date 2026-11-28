package cz.alldots.app.sdk

import cz.alldots.app.data.AuthenticatedApi
import cz.alldots.app.data.HttpProjectMailSignalsRepository
import cz.alldots.app.presentation.ProjectMailSignalsViewModel
import cz.alldots.app.presentation.ProjectMailSignalsViewModelFactory

/** The mail signals of projects, of [HomeSDK]. Every call creates a new ViewModel that the caller owns. */
class MailSignalsSDK internal constructor(api: AuthenticatedApi) {
    private val viewModels = ProjectMailSignalsViewModelFactory(HttpProjectMailSignalsRepository(api))

    fun projectMailSignalsViewModel(projectId: String): ProjectMailSignalsViewModel = viewModels.viewModel(projectId)
}
