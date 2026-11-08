plugins { id("semprec.android.compose") }
dependencies {
    // Features build their screens from these; the BOM keeps every Compose artifact on one release.
    api(platform(libs.compose.bom))
    api(libs.compose.ui)
    api(libs.compose.material3)
    api(libs.coroutines.core)
    implementation(libs.lifecycle.compose)
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
}
