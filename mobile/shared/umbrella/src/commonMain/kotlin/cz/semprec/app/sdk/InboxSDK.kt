package cz.semprec.app.sdk

import cz.semprec.app.presentation.InboxViewModel
import cz.semprec.app.presentation.InboxViewModelFactory

/** The Inbox screen; [HomeSDK.inbox] hands it out. */
class InboxSDK internal constructor(private val factory: InboxViewModelFactory) {
    /** One new ViewModel per call; the caller owns it. */
    fun inboxViewModel(): InboxViewModel = factory.inboxViewModel()
}
