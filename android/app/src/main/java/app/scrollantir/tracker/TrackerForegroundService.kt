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

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "onCreate")
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

        ForwarderWorker.enqueuePeriodic(applicationContext)
        CleanupWorker.enqueuePeriodic(applicationContext)

        _running.value = true
        return START_STICKY
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

        _running.value = false
        scope.cancel()
        super.onDestroy()
    }

    private fun startInForegroundCompat() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIF_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
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

        private val _running = MutableStateFlow(false)
        val running: StateFlow<Boolean> = _running.asStateFlow()

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
    }
}
