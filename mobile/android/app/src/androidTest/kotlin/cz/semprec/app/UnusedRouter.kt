package cz.semprec.app

import cz.semprec.app.feature.home.HomeRouter

/** The Home screens call the router only on user input, which the tests that compose them on their own do not give. */
internal object UnusedRouter : HomeRouter {
    override fun showDetail(id: String) = error("The test gives no user input.")

    override fun closeDetail() = error("The test gives no user input.")
}
