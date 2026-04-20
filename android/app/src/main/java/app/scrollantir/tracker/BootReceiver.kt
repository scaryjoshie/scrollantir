package app.scrollantir.tracker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            Log.i(TAG, "ACTION_BOOT_COMPLETED — starting tracker service")
            TrackerForegroundService.start(context)
        }
    }

    companion object {
        const val TAG = "ScrollantirBoot"
    }
}
