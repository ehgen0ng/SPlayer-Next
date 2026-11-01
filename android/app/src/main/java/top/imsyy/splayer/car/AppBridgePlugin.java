package top.imsyy.splayer.car;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.IBinder;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.CompletableFuture;
import org.json.JSONArray;

/** Capacitor 仅负责消息传递，业务 API 在共享 Node 模块中执行 */
@CapacitorPlugin(name = "SPlayer")
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
public final class AppBridgePlugin extends Plugin {
    private final CompletableFuture<PlaybackService> serviceReady = new CompletableFuture<>();
    private PlaybackService service;
    private boolean visible;
    private boolean bound;
    private final ServiceConnection connection = new ServiceConnection() {
        /**
         * 完成应用内后台服务绑定
         * @param name - 服务名称
         * @param binder - 本地绑定对象
         */
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            service = ((PlaybackService.LocalBinder) binder).getService();
            service.setVisible(visible);
            serviceReady.complete(service);
        }
        /**
         * 服务异常退出时停止持有旧实例
         * @param name - 服务名称
         */
        @Override public void onServiceDisconnected(ComponentName name) { service = null; }
    };

    /** 绑定原生后台服务并把低频业务事件交给界面 */
    @Override public void load() {
        NodeRuntime.setEventListener(message -> {
            if (!visible && message.optBoolean("visibleOnly")) return;
            try { notifyListeners("event", JSObject.fromJSONObject(message)); }
            catch (Exception error) { Log.e("SPlayer", "界面事件转换失败", error); }
        });
        Intent intent = new Intent(getContext(), PlaybackService.class).setAction("splayer:local");
        getContext().startService(intent);
        bound = getContext().bindService(intent, connection, Context.BIND_AUTO_CREATE);
        if (!bound) serviceReady.completeExceptionally(new IllegalStateException("无法连接播放服务"));
    }

    /**
     * 路由原生播放和共享业务请求
     * @param call - 通道与参数
     */
    @PluginMethod public void invoke(PluginCall call) {
        String channel = call.getString("channel");
        JSONArray args = call.getArray("args", new com.getcapacitor.JSArray());
        if (channel == null) { call.reject("缺少方法名"); return; }
        serviceReady.thenCompose(current -> {
            if (channel.startsWith("android:") || channel.startsWith("player:") || channel.startsWith("cache:")
                || channel.equals("shell:openExternal")) return current.invoke(channel, args);
            if (channel.equals("window:ready") || channel.equals("window:startupComplete")) {
                return NodeRuntime.start(getContext()).thenApply(ignored -> null);
            }
            if (channel.equals("window:startupFailed")) {
                Log.e("SPlayer", "界面启动失败: " + args.optString(0));
                return CompletableFuture.completedFuture(null);
            }
            return NodeRuntime.invoke(channel, args);
        }).whenComplete((value, error) -> {
            if (error != null) call.reject(error.getMessage());
            else call.resolve(new JSObject().put("value", value == null ? org.json.JSONObject.NULL : value));
        });
    }

    /** 界面恢复时从原生权威状态继续显示 */
    @Override protected void handleOnResume() {
        visible = true;
        if (service != null) service.setVisible(true);
    }

    /** 界面离开前台即停止高频事件 */
    @Override protected void handleOnPause() {
        visible = false;
        if (service != null) service.setVisible(false);
    }

    /** 释放界面绑定，正在播放的前台媒体服务继续运行 */
    @Override protected void handleOnDestroy() {
        NodeRuntime.setEventListener(null);
        if (service != null) service.setVisible(false);
        if (bound) getContext().unbindService(connection);
        service = null;
    }
}
