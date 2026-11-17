package cz.semprec.app.domain

/**
 * Loads the overview and decides what it lists: active areas by position, the pinned projects by their pinned order,
 * and the collections the server shows to a client, by its order. Equal orders (and missing ones, last) fall back to
 * the name, so the list never depends on the order the server happened to answer in.
 */
class LoadOverview(private val repository: OverviewRepository) {
    suspend operator fun invoke(): RepositoryResult<Overview> = when (val loaded = repository.load()) {
        is RepositoryResult.Failure -> loaded
        is RepositoryResult.Content -> RepositoryResult.Content(loaded.value.arranged())
    }
}

private fun Overview.arranged(): Overview = copy(
    areas = areas.filter { it.active }
        .sortedWith(compareBy<OverviewArea> { it.position ?: Double.MAX_VALUE }.thenBy { it.name.lowercase() }),
    projects = projects.filter { it.pinned }
        .sortedWith(compareBy<OverviewProject> { it.pinnedOrder ?: Double.MAX_VALUE }.thenBy { it.name.lowercase() }),
    collections = collections.filter { it.clientVisible && !it.hidden }
        .sortedWith(compareBy<OverviewCollection> { it.order ?: Int.MAX_VALUE }.thenBy { it.name.lowercase() }),
)
