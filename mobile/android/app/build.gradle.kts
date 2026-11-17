plugins { id("semprec.android.application") }

android {
    // The About sheet shows BuildConfig.VERSION_NAME and BuildConfig.VERSION_CODE.
    buildFeatures.buildConfig = true
    buildTypes {
        debug { applicationIdSuffix = ".debug" }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }
    // Library translations are packaged only for the languages the app itself is translated to.
    androidResources.localeFilters += listOf("en", "cs")
    lint {
        // One lint run of the app also checks every Android module it depends on, and any finding fails it.
        checkDependencies = true
        warningsAsErrors = true
        // These compare the pinned versions with releases published since, so an unchanged build could start
        // failing. Versions are raised deliberately in gradle/libs.versions.toml instead.
        disable += setOf("GradleDependency", "AndroidGradlePluginVersion", "NewerVersionAvailable")
    }
}

dependencies {
    implementation(project(":android:core:ui"))
    implementation(project(":android:feature:home"))
    implementation(project(":android:feature:settings"))
    implementation(project(":shared:presentation"))
    implementation(project(":shared:umbrella"))
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.compose)
    implementation(libs.navigation.compose)
    implementation(libs.kotlinx.serialization.core)
    implementation(libs.koin.compose)
    implementation(libs.compose.material.icons)
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.test)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.espresso.core)
}
