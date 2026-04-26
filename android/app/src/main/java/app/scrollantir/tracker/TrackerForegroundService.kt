package app.scrollantir.tracker

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import app.scrollantir.MainActivity
import app.scrollantir.R
import app.scrollantir.db.AppDatabase
import app.scrollantir.net.CleanupWorker
import app.scrollantir.net.DeviceId
import app.scrollantir.net.ForwarderWorker
import app.scrollantir.net.SecurePrefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

class TrackerForegroundService : Service() {

    private val supervisor = SupervisorJob()
    private val scope = CoroutineScope(Dispatchers.Default + supervisor)
    private var pollerJob: Job? = null
    private var poller: UsageStatsPoller? = null
    private var screenWatcher: ScreenWatcher? = null
    private var activityWatcher: ActivityWatcher? = null
    private var locationWatcher: LocationWatcher? = null

    /**
     * Re-anchor every in-memory in-flight span to [nowMs] without emitting.
     * Called by Settings after wiping the events table so live sessions
     * don't re-emit pre-wipe start times when they eventually close.
     * Location in-flight (ActivityWatcher) and content-mode in-flight
     * (ContentDetectorService — separate service) are also reset by their
     * own static entry points.
     */
    fun resetInMemorySpansToNow(nowMs: Long) {
        screenWatcher?.resetSpansToNow(nowMs)
        activityWatcher?.resetSpanToNow(nowMs)
        // UsageStatsPoller uses a companion-level active-instance pattern,
        // so it's reset via its own static method (see Settings).
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "onCreate")
        activeInstance = this
        DeviceId.prime(applicationContext)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "onStartCommand")
        startInForegroundCompat()

        val dao = AppDatabase.get(applicationContext).events()

        if (screenWatcher == null) {
            screenWatcher = ScreenWatcher(applicationContext, dao, scope).also { it.register() }
        }

        if (pollerJob == null || pollerJob?.isActive != true) {
            val p = UsageStatsPoller(applicationContext, dao)
            poller = p
            pollerJob = scope.launch { p.run() }
        }

        reconcileLocationWatchers(dao)

        ForwarderWorker.enqueuePeriodic(applicationContext)
        CleanupWorker.enqueuePeriodic(applicationContext)

        _running.value = true
        return START_STICKY
    }

    /**
     * Align the running state of [ActivityWatcher] and [LocationWatcher] to
     * the user's KEY_LOCATION_ENABLED preference. Called from onStartCommand
     * so settings can poke us via startService() whenever the toggle flips.
     */
    private fun reconcileLocationWatchers(dao: app.scrollantir.db.EventDao) {
        val enabled = SecurePrefs.get(applicationContext)
            .getBoolean(SecurePrefs.KEY_LOCATION_ENABLED, false)

        if (enabled) {
            if (locationWatcher == null) {
                locationWatcher = LocationWatcher(applicationContext, dao, scope)
            }
            if (activityWatcher == null) {
                val loc = locationWatcher!!
                val aw = ActivityWatcher(
                    applicationContext, dao, scope,
                    onStateChange = { newState ->
                        // Tier 1 anchor + Tier 2 periodic reconfigure in one call.
                        loc.onActivityChange(newState)
                    }
                )
                activityWatcher = aw
                aw.register()
                // Anchor an initial reading so the map has something to show
                // even before the first transition fires.
                loc.requestSingleReading("start")
            }
        } else {
            activityWatcher?.let { aw ->
                aw.unregister()
                try {
                    runBlocking(Dispatchers.IO + NonCancellable) {
                        aw.flushCurrent(System.currentTimeMillis())
                    }
                } catch (t: Throwable) {
                    Log.w(TAG, "activity flush on disable failed", t)
                }
            }
            activityWatcher = null
            locationWatcher?.stop()
            locationWatcher = null
        }
    }

    override fun onDestroy() {
        Log.i(TAG, "onDestroy")
        screenWatcher?.unregister()
        screenWatcher = null

        // Flush any in-flight foreground session before we cancel the scope.
        // runBlocking + NonCancellable ensures the DB write completes even
        // though the service is tearing down.
        poller?.let { p ->
            try {
                runBlocking(Dispatchers.IO + NonCancellable) {
                    p.flushCurrent(System.currentTimeMillis())
                }
            } catch (t: Throwable) {
                Log.w(TAG, "final flush failed", t)
            }
        }
        poller = null

        activityWatcher?.let { aw ->
            aw.unregister()
            try {
                aw.flushCurrent(System.currentTimeMillis())
            } catch (t: Throwable) {
                Log.w(TAG, "activity flush on destroy failed", t)
            }
        }
        activityWatcher = null
        locationWatcher?.stop()
        locationWatcher = null

        _running.value = false
        activeInstance = null
        scope.cancel()
        super.onDestroy()
    }

    private fun startInForegroundCompat() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // Include the LOCATION type only when the user has enabled
            // location AND granted fine-location permission. Declaring the
            // LOCATION FGS type without the permission crashes the start
            // on Android 14+. Android 14+ re-calls of startForeground with
            // a new type combo should update the declared type in place;
            // we still catch SecurityException as a belt+braces against
            // vendor behavior drift and fall back to DATA_SYNC only so at
            // least the service stays up.
            val locationEnabled = SecurePrefs.get(applicationContext)
                .getBoolean(SecurePrefs.KEY_LOCATION_ENABLED, false)
            val desiredTypes = if (locationEnabled &&
                LocationWatcher.hasFineLocationPermission(applicationContext)
            ) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            } else {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            }
            try {
                startForeground(NOTIF_ID, notification, desiredTypes)
            } catch (t: Throwable) {
                Log.e(TAG, "startForeground($desiredTypes) rejected; falling back to DATA_SYNC", t)
                startForeground(
                    NOTIF_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                )
            }
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Tracking",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Persistent notification while tracking is active"
                setShowBadge(false)
            }
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification() = NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle("Scrollantir")
        .setContentText("Tracking active")
        .setSmallIcon(R.mipmap.ic_launcher)
        .setOngoing(true)
        .setContentIntent(
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
        )
        .build()

    companion object {
        const val TAG = "ScrollantirSvc"
        private const val NOTIF_ID = 1
        private const val CHANNEL_ID = "scrollantir-tracking"

        @Volatile private var activeInstance: TrackerForegroundService? = null

        private val _running = MutableStateFlow(false)
        val running: StateFlow<Boolean> = _running.asStateFlow()

        /**
         * Settings reset entry point. Walks every known in-memory span
         * holder (service-owned watchers + separately-running
         * ContentDetectorService + the global UsageStatsPoller companion)
         * and re-anchors them to the current instant. Safe to call whether
         * or not the service is running — each holder is a no-op if it
         * has no live state.
         */
        fun resetAllSpansToNow() {
            val now = System.currentTimeMillis()
            activeInstance?.resetInMemorySpansToNow(now)
            UsageStatsPoller.resetSpanToNow(now)
            ContentDetectorService.resetSpanToNow(now)
        }

        /**
         * Start the tracker service and persist "tracking should be on"
         * so BootReceiver knows to re-start after a reboot.
         */
        fun start(context: Context) {
            SecurePrefs.get(context).edit()
                .putBoolean(SecurePrefs.KEY_TRACKING_ENABLED, true)
                .apply()
            val intent = Intent(context, TrackerForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /**
         * Stop the tracker and persist "tracking is off" so a reboot won't
         * silently resurrect it.
         */
        fun stop(context: Context) {
            SecurePrefs.get(context).edit()
                .putBoolean(SecurePrefs.KEY_TRACKING_ENABLED, false)
                .apply()
            context.stopService(Intent(context, TrackerForegroundService::class.java))
        }

        /** For BootReceiver: was the user running tracking before reboot? */
        fun wasTrackingEnabled(context: Context): Boolean {
            return SecurePrefs.get(context)
                .getBoolean(SecurePrefs.KEY_TRACKING_ENABLED, false)
        }

        /**
         * Called by SettingsScreen when the user flips the location toggle.
         * Sends a fresh start intent to the running service; onStartCommand
         * will re-run startInForegroundCompat with the updated FGS type
         * and reconcile the watchers against the new pref value.
         *
         * We deliberately do NOT stop+restart the service: stopService is
         * async and racing it with startForegroundService can either hit
         * the still-live old instance or create a teardown window where
         * ScreenWatcher/UsageStatsPoller lose state. The re-call of
         * startForeground(..., newType) is guarded by a try/catch inside
         * startInForegroundCompat so a rejected type upgrade logs and
         * falls back rather than silently stopping collection.
         *
         * No-op if tracking itself isn't enabled.
         */
        fun reloadLocation(context: Context) {
            val trackingEnabled = SecurePrefs.get(context)
                .getBoolean(SecurePrefs.KEY_TRACKING_ENABLED, false)
            if (!trackingEnabled) return

            val intent = Intent(context, TrackerForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
