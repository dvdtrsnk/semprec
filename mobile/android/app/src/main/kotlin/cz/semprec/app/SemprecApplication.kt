package cz.semprec.app

import android.app.Application
import org.koin.core.context.startKoin

class SemprecApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        startKoin { modules(appModule) }
    }
}
