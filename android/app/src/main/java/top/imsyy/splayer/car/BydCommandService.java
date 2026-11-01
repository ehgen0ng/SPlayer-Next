package top.imsyy.splayer.car;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.ComponentName;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import java.util.concurrent.CompletableFuture;

/** 仅承接厂商冷启动指令，执行期间绑定现有媒体服务，完成后退出 */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
public final class BydCommandService extends Service {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final CompletableFuture<PlaybackService> playback = new CompletableFuture<>();
    private boolean bound;
    private int pending;
    private int lastStart;
    private final ServiceConnection connection = new ServiceConnection() {
        /**
         * 取得应用内部的媒体服务，继续使用同一队列
         * @param name - 本地服务组件
         * @param binder - 应用内绑定对象
         */
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            playback.complete(((PlaybackService.LocalBinder) binder).getService());
        }

        /**
         * 媒体服务断开时结束短时承接服务
         * @param name - 断开的组件
         */
        @Override public void onServiceDisconnected(ComponentName name) { stopSelf(); }
    };

    /** 先建立前台通知，再启动媒体服务，避免等待搜索触发前台服务超时 */
    @Override public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) getSystemService(NotificationManager.class).createNotificationChannel(
            new NotificationChannel("byd-voice", "语音播放", NotificationManager.IMPORTANCE_LOW));
        startForeground(7312, new NotificationCompat.Builder(this, "byd-voice")
            .setSmallIcon(android.R.drawable.ic_media_play).setContentTitle(getString(R.string.app_name))
            .setContentText("正在处理语音指令").setOngoing(true).setSilent(true).build());
        bound = bindService(new Intent(this, PlaybackService.class).setAction("splayer:local"), connection, BIND_AUTO_CREATE);
        if (!bound) playback.completeExceptionally(new IllegalStateException("媒体服务绑定失败"));
        main.postDelayed(() -> playback.completeExceptionally(new IllegalStateException("媒体服务启动超时")), 10_000);
    }

    /**
     * 有界承接厂商请求，完成后释放自身，不接管媒体通知
     * @param intent - 厂商启动或广播载荷
     * @param flags - 系统启动标志
     * @param startId - 启动序号
     * @return 指令不需要系统自动重放
     */
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        lastStart = startId;
        if (intent == null || pending >= 8) {
            if (pending == 0) stopSelf(startId);
            return START_NOT_STICKY;
        }
        pending++;
        playback.thenCompose(service -> service.handleBydIntent(intent)).whenComplete((value, error) -> main.post(() -> {
            if (error != null) Log.w("SPlayerByd", "厂商指令处理失败", error);
            if (--pending == 0) stopSelf(lastStart);
        }));
        return START_NOT_STICKY;
    }

    /**
     * 默认候选名单中的启动服务无需专用绑定接口
     * @param intent - 绑定意图
     * @return 无绑定接口
     */
    @Override public IBinder onBind(Intent intent) { return null; }

    /** 解除临时绑定和通知，实际播放由 MediaSessionService 继续维持 */
    @Override public void onDestroy() {
        main.removeCallbacksAndMessages(null);
        if (bound) unbindService(connection);
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }
}
