package cz.alldots.app.sdk

import cz.alldots.app.presentation.InboxViewModel
import cz.alldots.app.presentation.InboxViewModelFactory

/** The Inbox screen; [HomeSDK.inbox] hands it out. */
class InboxSDK internal constructor(private val factory: InboxViewModelFactory) {
    /** One new ViewModel per call; the caller owns it. */
    fun inboxViewModel(): InboxViewModel = factory.inboxViewModel()
}
