package top.imsyy.splayer.car;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import com.getcapacitor.JSObject;
import java.lang.ref.WeakReference;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.HttpCookie;
import java.net.URI;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import org.json.JSONArray;
import org.json.JSONObject;

/** 平台能力边界，业务账号 Cookie 与 SDK WebView 的浏览器存储隔离 */
final class NativePlatform {
    static WeakReference<MainActivity> activity = new WeakReference<>(null);
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final CookieManager cookies = new CookieManager(null, CookiePolicy.ACCEPT_ORIGINAL_SERVER);
    private final Map<String, CompletableFuture<Object>> evaluations = new HashMap<>();
    private WebView sdk;
    private CompletableFuture<Object> sdkReady;

    /**
     * 绑定应用上下文，不保留 Activity 生命周期
     * @param context - 应用上下文
     */
    NativePlatform(Context context) { this.context = context.getApplicationContext(); }

    /**
     * 分发真实原生平台方法，未支持操作明确失败
     * @param channel - 平台通道
     * @param args - 方法参数
     * @return 执行结果
     */
    CompletableFuture<Object> invoke(String channel, JSONArray args) {
        try {
            Object result = JSONObject.NULL;
            switch (channel) {
                case "android:deviceInfo":
                    result = new JSObject().put("type", "Android")
                        .put("arch", android.os.Build.SUPPORTED_ABIS[0])
                        .put("release", android.os.Build.VERSION.RELEASE);
                    break;
                case "web:initialize": return initializeSdk();
                case "web:evaluate": return evaluate(args.getString(0));
                case "web:getCookies": {
                    JSONArray values = new JSONArray();
                    for (HttpCookie cookie : cookies.getCookieStore().get(new URI(args.getString(0)))) {
                        values.put(new JSObject().put("name", cookie.getName()).put("value", cookie.getValue()));
                    }
                    result = values;
                    break;
                }
                case "web:setCookie": {
                    JSONObject value = args.getJSONObject(0);
                    URI uri = new URI(value.getString("url"));
                    HttpCookie cookie = new HttpCookie(value.getString("name"), value.getString("value"));
                    cookie.setPath(value.getString("path"));
                    cookie.setSecure(value.getBoolean("secure"));
                    cookie.setVersion(0);
                    cookies.getCookieStore().add(uri, cookie);
                    break;
                }
                case "web:clearCookies": cookies.getCookieStore().removeAll(); break;
                case "web:cookieHeader": {
                    Map<String, List<String>> headers = cookies.get(new URI(args.getString(0)), java.util.Collections.emptyMap());
                    result = String.join("; ", headers.getOrDefault("Cookie", java.util.Collections.emptyList()));
                    break;
                }
                case "web:storeCookies": {
                    JSONArray values = args.getJSONArray(1);
                    java.util.ArrayList<String> headers = new java.util.ArrayList<>();
                    for (int i = 0; i < values.length(); i++) headers.add(values.getString(i));
                    cookies.put(new URI(args.getString(0)), java.util.Collections.singletonMap("Set-Cookie", headers));
                    break;
                }
                case "system:pickPlugin": {
                    MainActivity current = activity.get();
                    if (current == null) throw new IllegalStateException("请在应用前台导入插件");
                    return current.pickPlugin();
                }
                case "system:loginNetease": throw new UnsupportedOperationException("安卓请使用二维码或 Cookie 登录");
                case "system:notify": Toast.makeText(context, args.getString(0) + "\n" + args.getString(1), Toast.LENGTH_LONG).show(); break;
                case "shell:openExternal": {
                    Uri uri = Uri.parse(args.getString(0));
                    if (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme())) throw new IllegalArgumentException("仅支持网页链接");
                    context.startActivity(new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    break;
                }
                default: throw new UnsupportedOperationException("安卓不支持此操作: " + channel);
            }
            return CompletableFuture.completedFuture(result);
        } catch (Exception error) {
            CompletableFuture<Object> future = new CompletableFuture<>();
            future.completeExceptionally(error);
            return future;
        }
    }

    /**
     * 创建无应用权限和账号 Cookie 的 SDK 执行页面
     * @return 页面加载完成后的 UA
     */
    private CompletableFuture<Object> initializeSdk() {
        if (sdkReady != null) return sdkReady;
        sdkReady = new CompletableFuture<>();
        sdk = new WebView(context);
        sdk.getSettings().setJavaScriptEnabled(true);
        sdk.getSettings().setDomStorageEnabled(true);
        sdk.getSettings().setAllowFileAccess(false);
        sdk.getSettings().setAllowContentAccess(false);
        android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(sdk, false);
        sdk.addJavascriptInterface(new ScriptResult(), "SPlayerSdkResult");
        sdk.setWebViewClient(new WebViewClient() {
            /**
             * SDK 只能在专属空白页运行，不能导航到其他文档
             * @param view - 当前环境
             * @param request - 导航请求
             * @return 始终阻止导航
             */
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }

            /**
             * 标记脚本执行环境可用
             * @param view - 当前环境
             * @param url - 页面地址
             */
            @Override public void onPageFinished(WebView view, String url) {
                sdkReady.complete(new JSObject().put("userAgent", view.getSettings().getUserAgentString()));
            }
        });
        sdk.loadDataWithBaseURL("https://splayer-sdk.invalid/", "<!doctype html><html><body></body></html>", "text/html", "UTF-8", null);
        return sdkReady;
    }

    /**
     * 执行宿主准备的 SDK 脚本并等待 Promise，结果通道不提供应用能力
     * @param code - 可信宿主准备的脚本
     * @return 可序列化结果
     */
    private CompletableFuture<Object> evaluate(String code) {
        if (sdk == null || !sdkReady.isDone()) throw new IllegalStateException("SDK 环境未就绪");
        if (evaluations.size() >= 16) throw new IllegalStateException("SDK 请求过多");
        String id = UUID.randomUUID().toString();
        CompletableFuture<Object> future = new CompletableFuture<>();
        evaluations.put(id, future);
        Runnable timeout = () -> future.completeExceptionally(new IllegalStateException("SDK 执行超时"));
        main.postDelayed(timeout, 45_000);
        future.whenComplete((value, error) -> {
            evaluations.remove(id);
            main.removeCallbacks(timeout);
        });
        sdk.evaluateJavascript("Promise.resolve().then(() => (0,eval)(" + JSONObject.quote(code)
            + ")).then(value => SPlayerSdkResult.complete(" + JSONObject.quote(id)
            + ", JSON.stringify({value: value === undefined ? null : value})), error => SPlayerSdkResult.complete("
            + JSONObject.quote(id) + ", JSON.stringify({error: String(error)})))", null);
        return future;
    }

    public final class ScriptResult {
        /**
         * 接收 SDK 结果，不能反向调用平台或读取账号
         * @param id - 本次脚本随机标识
         * @param text - 结果 JSON
         */
        @JavascriptInterface public void complete(String id, String text) {
            main.post(() -> {
                CompletableFuture<Object> future = evaluations.get(id);
                if (future == null) return;
                try {
                    if (text.length() > 1024 * 1024) throw new IllegalArgumentException("SDK 返回过大");
                    JSONObject result = new JSONObject(text);
                    if (result.has("error")) throw new IllegalStateException(result.getString("error"));
                    future.complete(result.opt("value"));
                } catch (Exception error) { future.completeExceptionally(error); }
            });
        }
    }

    /** 销毁 SDK 页面并拒绝尚未完成的请求 */
    void close() {
        for (CompletableFuture<Object> future : new java.util.ArrayList<>(evaluations.values())) {
            future.completeExceptionally(new IllegalStateException("SDK 环境已销毁"));
        }
        if (sdk != null) sdk.destroy();
        NodeRuntime.publish("web:destroyed", JSONObject.NULL);
    }
}
