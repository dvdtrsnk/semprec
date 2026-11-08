plugins { id("semprec.android.compose") }
dependencies {
    implementation(project(":android:core:ui"))
    implementation(project(":shared:presentation"))
    implementation(libs.lifecycle.compose)
    implementation(libs.compose.material.icons)
    testImplementation(libs.junit)
}
