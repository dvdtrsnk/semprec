import org.gradle.api.Project
import org.gradle.api.artifacts.VersionCatalogsExtension
import org.gradle.kotlin.dsl.getByType

/**
 * Lets every Compose module declare `@Preview` functions and render them in Android Studio: the preview
 * annotations at compile time, the tooling that renders them in debug builds only, both versioned by the
 * Compose BOM.
 */
internal fun Project.addComposePreviewTooling() {
    val libs = extensions.getByType<VersionCatalogsExtension>().named("libs")
    val bom = dependencies.platform(libs.findLibrary("compose-bom").get())
    dependencies.add("implementation", bom)
    dependencies.add("implementation", libs.findLibrary("compose-preview").get())
    dependencies.add("debugImplementation", libs.findLibrary("compose-tooling").get())
}
