package app.scrollantir.tracker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        // Only resume tracking if the user had it on before the reboot.
        // Otherwise a user who paused from Settings would silently have it
        // come back on, which is invasive.
        if (TrackerForegroundService.wasTrackingEnabled(context)) {
            Log.i(TAG, "ACTION_BOOT_COMPLETED — resuming tracker (was enabled before reboot)")
            TrackerForegroundService.start(context)
        } else {
            Log.i(TAG, "ACTION_BOOT_COMPLETED — tracker was paused, not resuming")
        }
    }

    companion object {
        const val TAG = "ScrollantirBoot"
    }
}
