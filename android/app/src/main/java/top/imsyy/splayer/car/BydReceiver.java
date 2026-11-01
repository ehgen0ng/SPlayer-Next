package top.imsyy.splayer.car;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import androidx.core.content.ContextCompat;

/** 接收清单声明的比亚迪广播，长操作转交短时前台命令服务 */
public final class BydReceiver extends BroadcastReceiver {
    /**
     * 保留原协议载荷并显式启动应用自己的命令服务
     * @param context - 广播上下文
     * @param intent - 厂商广播
     */
    @Override public void onReceive(Context context, Intent intent) {
        if ((BydVoice.PREFIX + "FUNCTION_UPDATE_RESULT").equals(intent.getAction())) {
            Log.i("SPlayerByd", "收到默认音乐注册回执，字段=" + (intent.getExtras() == null ? "[]" : intent.getExtras().keySet()));
            return;
        }
        try {
            ContextCompat.startForegroundService(context, new Intent(intent).setComponent(
                new android.content.ComponentName(context, BydCommandService.class)));
        } catch (RuntimeException error) { Log.w("SPlayerByd", "系统拒绝后台语音唤起", error); }
    }
}
