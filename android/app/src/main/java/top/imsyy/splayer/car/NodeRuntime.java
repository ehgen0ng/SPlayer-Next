package top.imsyy.splayer.car;

import android.content.Context;
import android.content.res.AssetManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.Base64;
import android.system.Os;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import java.security.KeyStore;
import java.security.cert.X509Certificate;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;
import org.json.JSONArray;
import org.json.JSONObject;

/** 应用进程内唯一的 Node 实例，后台服务与界面共用其插件、账号和数据库 */
public final class NodeRuntime {
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final AtomicLong SEQUENCE = new AtomicLong();
    private static final Map<String, CompletableFuture<Object>> PENDING = new HashMap<>();
    private static CompletableFuture<Void> startup;
    private static Consumer<JSONObject> eventListener;
    private static NativeHandler nativeHandler;

    public interface NativeHandler {
        /**
         * 调用真实的安卓平台能力
         * @param channel - 原生方法名
         * @param args - 方法参数
         * @return 异步执行结果
         */
        CompletableFuture<Object> invoke(String channel, JSONArray args);
    }

    /**
     * 启动一次运行时，后续服务重建继续使用同一实例
     * @param context - 应用上下文
     * @return 数据库及业务入口初始化完成的信号
     */
    public static synchronized CompletableFuture<Void> start(Context context) {
        if (startup != null) return startup;
        startup = new CompletableFuture<>();
        Context application = context.getApplicationContext();
        new Thread(() -> {
            try {
                File bundle = new File(application.getFilesDir(), "node");
                String version = readText(application.getAssets().open("node/version"));
                File marker = new File(bundle, "version");
                String installed = marker.exists() ? readText(new FileInputStream(marker)) : "";
                if (!version.equals(installed)) {
                    File staged = new File(application.getFilesDir(), "node.partial");
                    deleteBundle(staged);
                    copyAssets(application.getAssets(), "node", staged);
                    deleteBundle(bundle);
                    if (!staged.renameTo(bundle)) throw new IOException("无法安装 Node 运行资源");
                }
                File certificates = new File(application.getFilesDir(), "system-ca.pem");
                TrustManagerFactory trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
                trust.init((KeyStore) null);
                try (FileOutputStream output = new FileOutputStream(certificates)) {
                    for (TrustManager manager : trust.getTrustManagers()) {
                        if (!(manager instanceof X509TrustManager)) continue;
                        for (X509Certificate certificate : ((X509TrustManager) manager).getAcceptedIssuers()) {
                            String pem = "-----BEGIN CERTIFICATE-----\n"
                                + Base64.encodeToString(certificate.getEncoded(), Base64.NO_WRAP)
                                + "\n-----END CERTIFICATE-----\n";
                            output.write(pem.getBytes(StandardCharsets.US_ASCII));
                        }
                    }
                }
                // Node 的内置根证书随版本冻结，补充 Android 当前信任的证书并继续校验 TLS
                Os.setenv("NODE_EXTRA_CA_CERTS", certificates.getAbsolutePath(), true);
                System.loadLibrary("node");
                System.loadLibrary("splayer");
                int code = startNode(new String[] {
                    "node",
                    new File(bundle, "start.cjs").getAbsolutePath(),
                    application.getFilesDir().getAbsolutePath(),
                    application.getApplicationInfo().nativeLibraryDir,
                    BuildConfig.VERSION_NAME,
                });
                fail(new IllegalStateException("Node 运行时已退出: " + code));
            } catch (Throwable error) {
                fail(error);
            }
        }, "splayer-node").start();
        return startup;
    }

    /**
     * 绑定服务提供的原生能力
     * @param handler - 原生方法处理器，服务销毁时传入 null
     */
    public static void setNativeHandler(NativeHandler handler) {
        nativeHandler = handler;
    }

    /**
     * 绑定当前界面的事件接收器
     * @param listener - 事件接收器，界面销毁时传入 null
     */
    public static void setEventListener(Consumer<JSONObject> listener) {
        eventListener = listener;
    }

    /**
     * 向共享业务发送调用，超时或通道拒绝时移除挂起请求
     * @param channel - 既有 IPC 方法名
     * @param args - 方法参数
     * @return 共享业务的实际结果
     */
    public static CompletableFuture<Object> invoke(String channel, JSONArray args) {
        CompletableFuture<Object> future = new CompletableFuture<>();
        String id = "java:" + SEQUENCE.incrementAndGet();
        synchronized (PENDING) {
            if (PENDING.size() >= 64) {
                future.completeExceptionally(new IllegalStateException("后台请求过多"));
                return future;
            }
            PENDING.put(id, future);
        }
        Runnable timeout = () -> future.completeExceptionally(new IOException("后台请求超时"));
        if (!channel.equals("plugin:pickAndInstall")) MAIN.postDelayed(timeout, 60_000);
        future.whenComplete((value, error) -> {
            synchronized (PENDING) { PENDING.remove(id); }
            MAIN.removeCallbacks(timeout);
        });
        CompletableFuture<Void> ready = startup;
        if (ready == null) {
            future.completeExceptionally(new IllegalStateException("Node 运行时尚未启动"));
            return future;
        }
        ready.whenComplete((value, error) -> {
            if (future.isDone()) return;
            if (error != null) {
                future.completeExceptionally(error);
                return;
            }
            try {
                JSONObject message = new JSONObject().put("type", "invoke").put("id", id)
                    .put("channel", channel).put("args", args);
                if (!sendToNode(message.toString())) throw new IOException("Node 消息队列不可用");
            } catch (Exception failure) {
                future.completeExceptionally(failure);
            }
        });
        return future;
    }

    /**
     * 将原生播放状态发送到共享业务和当前界面
     * @param channel - 事件通道
     * @param data - 事件数据
     */
    public static void publish(String channel, Object data) {
        try {
            JSONObject event = new JSONObject().put("type", "event")
                .put("channel", channel).put("data", data);
            if (startup != null && startup.isDone() && !startup.isCompletedExceptionally()) {
                if (!sendToNode(event.toString())) Log.w("SPlayer", "后台事件队列已满: " + channel);
            }
            if (eventListener != null) eventListener.accept(event);
        } catch (Exception error) {
            Log.e("SPlayer", "事件发送失败", error);
        }
    }

    /**
     * 接收 JNI 回调并在主线程处理平台调用与界面事件
     * @param text - Node 消息 JSON
     */
    private static void onNodeMessage(String text) {
        MAIN.post(() -> {
            try {
                JSONObject message = new JSONObject(text);
                String type = message.getString("type");
                if (type.equals("ready")) {
                    startup.complete(null);
                } else if (type.equals("log")) {
                    String level = message.optString("level");
                    int priority = level.equals("error") ? Log.ERROR : level.equals("warn") ? Log.WARN : level.equals("debug") ? Log.DEBUG : Log.INFO;
                    Log.println(priority, "SPlayer", message.optString("message"));
                } else if (type.equals("fatal")) {
                    fail(new IllegalStateException(message.getString("error")));
                } else if (type.equals("result")) {
                    CompletableFuture<Object> future;
                    synchronized (PENDING) { future = PENDING.get(message.getString("id")); }
                    if (future == null) return;
                    if (message.has("error")) future.completeExceptionally(new IOException(message.getString("error")));
                    else future.complete(message.opt("value"));
                } else if (type.equals("event")) {
                    if (eventListener != null) eventListener.accept(message);
                } else if (type.equals("invoke")) {
                    String id = message.getString("id");
                    if (nativeHandler == null) throw new IllegalStateException("原生服务尚未就绪");
                    nativeHandler.invoke(message.getString("channel"), message.getJSONArray("args"))
                        .whenComplete((value, error) -> {
                            try {
                                JSONObject result = new JSONObject().put("type", "result").put("id", id);
                                if (error == null) result.put("value", value == null ? JSONObject.NULL : value);
                                else result.put("error", error.getMessage());
                                if (!sendToNode(result.toString())) Log.e("SPlayer", "原生响应队列已满");
                            } catch (Exception failure) {
                                Log.e("SPlayer", "原生响应发送失败", failure);
                            }
                        });
                }
            } catch (Exception error) {
                Log.e("SPlayer", "Node 消息处理失败", error);
            }
        });
    }

    /**
     * 让所有等候者收到运行时退出原因
     * @param error - 初始化或运行失败原因
     */
    private static void fail(Throwable error) {
        Log.e("SPlayer", "Node 运行时失败", error);
        if (startup != null) startup.completeExceptionally(error);
        ArrayList<CompletableFuture<Object>> pending;
        synchronized (PENDING) { pending = new ArrayList<>(PENDING.values()); }
        for (CompletableFuture<Object> future : pending) future.completeExceptionally(error);
    }

    /**
     * 读取资源版本标识并关闭输入流
     * @param input - 输入流
     * @return UTF-8 文本
     */
    private static String readText(InputStream input) throws IOException {
        try (InputStream stream = input; java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = stream.read(buffer)) != -1) output.write(buffer, 0, count);
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    /**
     * 释放随 APK 分发的 Node 资源到内部目录
     * @param assets - 安卓资源管理器
     * @param source - APK 内的资源路径
     * @param destination - 内部文件路径
     */
    private static void copyAssets(AssetManager assets, String source, File destination) throws IOException {
        String[] children = assets.list(source);
        if (children != null && children.length > 0) {
            if (!destination.mkdirs() && !destination.isDirectory()) throw new IOException("无法创建资源目录");
            for (String child : children) copyAssets(assets, source + "/" + child, new File(destination, child));
            return;
        }
        try (InputStream input = assets.open(source); FileOutputStream output = new FileOutputStream(destination)) {
            byte[] buffer = new byte[32768];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        }
    }

    /**
     * 删除旧的只读程序资源，不触及用户数据目录
     * @param file - 程序资源目录或文件
     */
    private static void deleteBundle(File file) throws IOException {
        if (!file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteBundle(child);
        if (!file.delete()) throw new IOException("无法清理旧程序资源: " + file.getName());
    }

    /**
     * 启动内嵌 Node，直到运行时退出
     * @param arguments - Node 命令行参数
     * @return 退出码
     */
    private static native int startNode(String[] arguments);

    /**
     * 向 Node 事件循环投递消息
     * @param message - JSON 消息
     * @return 是否成功入队
     */
    private static native boolean sendToNode(String message);
}
