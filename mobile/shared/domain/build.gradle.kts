plugins { id("semprec.kmp") }
kotlin {
    sourceSets {
        commonMain.dependencies { api(project(":shared:core")) }
        commonTest.dependencies { implementation(libs.coroutines.test) }
    }
}
