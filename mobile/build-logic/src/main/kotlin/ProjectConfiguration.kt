import com.android.build.api.dsl.CommonExtension
import org.gradle.api.JavaVersion
import org.gradle.api.Project
import java.util.Properties

/** Reads one value from the hand-maintained `gradle/project.properties` of the mobile Gradle root. */
fun Project.configurationValue(name: String): String {
    val properties = Properties()
    rootProject.file("gradle/project.properties").inputStream().use(properties::load)
    return properties.getProperty(name) ?: error("gradle/project.properties has no value for $name.")
}

/** Android namespace of a module: the root namespace followed by its Gradle path (`cz.semprec.app.shared.core`). */
fun Project.moduleNamespace(): String = configurationValue("namespace") + path.replace(':', '.')

/** SDK levels, Java 17 and test defaults shared by every Android module, KMP modules included. */
internal fun Project.configureAndroid(android: CommonExtension<*, *, *, *, *, *>) {
    android.compileSdk = configurationValue("androidCompileSdk").toInt()
    android.buildToolsVersion = configurationValue("androidBuildTools")
    android.defaultConfig.minSdk = configurationValue("androidMinSdk").toInt()
    android.defaultConfig.testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    android.compileOptions.sourceCompatibility = JavaVersion.VERSION_17
    android.compileOptions.targetCompatibility = JavaVersion.VERSION_17
    android.testOptions.unitTests.isReturnDefaultValues = true
}
