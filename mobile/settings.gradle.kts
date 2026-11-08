pluginManagement {
    includeBuild("build-logic")
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}

val configuration = java.util.Properties().apply { file("gradle/project.properties").inputStream().use(::load) }
rootProject.name = configuration.getProperty("projectName") ?: error("gradle/project.properties has no projectName.")

// Project directories follow the Gradle paths: :shared:core lives in shared/core.
include(":shared:core", ":shared:domain", ":shared:data", ":shared:presentation", ":shared:umbrella")
include(":android:core:ui", ":android:feature:home", ":android:feature:settings", ":android:app")
