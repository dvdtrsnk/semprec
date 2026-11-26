plugins { id("semprec.kmp") }
kotlin {
    sourceSets {
        commonMain.dependencies {
            api(project(":shared:core"))
            implementation(project(":shared:domain"))
            api(libs.lifecycle.viewmodel)
            api(libs.coroutines.core)
            implementation(libs.kotlinx.datetime)
        }
        commonTest.dependencies { implementation(libs.coroutines.test) }
    }
}
