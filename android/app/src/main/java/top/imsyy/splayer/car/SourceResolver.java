package top.imsyy.splayer.car;

import android.net.Uri;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.ResolvingDataSource;
import androidx.media3.datasource.cache.Cache;
import androidx.media3.datasource.cache.ContentMetadata;
import com.getcapacitor.JSObject;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/** 在 Media3 加载线程内按缓存键解析音源，独立于 WebView 生命周期 */
@UnstableApi
final class SourceResolver implements ResolvingDataSource.Resolver {
    private final Cache cache;
    final Map<String, JSONObject> tracks = new ConcurrentHashMap<>();
    volatile JSONObject preferences = new JSObject().put("preferPluginSource", false).put("allowTrialPlay", false);
    private final LinkedHashMap<String, Resolved> resolved = new LinkedHashMap<>(4, 0.75f, true);
    private volatile int preferencesVersion;
    private final Set<String> preloadFailures = ConcurrentHashMap.newKeySet();

    private static final class Resolved {
        final Uri uri;
        final long expires;
        final String pluginId;
        final String cacheKey;
        boolean reported;
        /**
         * 保留有限时间的当前音源地址，避免分段读取重复解析
         * @param value - 当前音源
         * @param plugin - 实际提供音源的插件标识
         * @param key - 按已验证音质生成的实际缓存键
         */
        Resolved(String value, String plugin, String key) {
            uri = Uri.parse(value);
            pluginId = plugin;
            cacheKey = key;
            expires = android.os.SystemClock.elapsedRealtime() + 5 * 60_000;
        }
    }

    /**
     * 共用播放缓存，完整文件命中时无需再次请求插件
     * @param cache - Media3 持有的有界缓存
     */
    SourceResolver(Cache cache) { this.cache = cache; }

    /**
     * 更新选源偏好并作废旧地址，预载开关变化不影响正在播放的歌曲
     * @param value - 前端同步或服务恢复的设置
     * @return 音质或选源规则是否改变
     */
    boolean updatePreferences(JSONObject value) {
        synchronized (resolved) {
            boolean changed = !preferences.optString("quality").equals(value.optString("quality"))
                || preferences.optBoolean("preferPluginSource") != value.optBoolean("preferPluginSource")
                || preferences.optBoolean("allowTrialPlay") != value.optBoolean("allowTrialPlay")
                || preferences.optBoolean("verifySourceArtist") != value.optBoolean("verifySourceArtist")
                || preferences.optBoolean("verifySourceDuration", true) != value.optBoolean("verifySourceDuration", true);
            preferences = value;
            if (changed) {
                preferencesVersion++;
                resolved.clear();
            }
            return changed;
        }
    }

    /**
     * 为同一曲目与音质生成稳定缓存键，隔离旧版未识别试听的 QQ 缓存
     * @param track - 曲目身份
     * @param quality - 请求音质
     * @return 不包含临时 URL 的缓存键
     */
    static String cacheKey(JSONObject track, String quality) {
        JSONObject plugin = track.optJSONObject("plugin");
        String origin = plugin == null ? "" : plugin.optString("pluginId") + ":" + plugin.optString("source") + ":";
        String source = track.optString("source");
        if ("qqmusic".equals(source)) source += ":v2";
        return source + ":" + origin + track.optString("id") + ":" + track.optString("extId") + ":" + quality;
    }

    /**
     * 记录本轮预载失败，正式切歌可立即顺延而不重复请求同一音源
     * @param key - 失败候选的队列缓存身份
     */
    void markPreloadFailure(String key) { preloadFailures.add(key); }

    /** 新播放上下文允许重试，失败集合最多保留当前队列中的曲目 */
    void clearPreloadFailures() { preloadFailures.clear(); }

    /**
     * 解析缓存缺失片段所需的网络地址
     * @param spec - 保留读取范围与稳定缓存键的请求
     * @return 带真实网络地址的请求
     */
    @Override public DataSpec resolveDataSpec(DataSpec spec) throws IOException {
        String key = spec.key;
        if (key == null) throw new IOException("播放请求缺少曲目身份");
        long bytes = ContentMetadata.getContentLength(cache.getContentMetadata(key));
        if (bytes > 0 && cache.isCached(key, 0, bytes)) return spec;
        if (preloadFailures.contains(key)) throw new IOException("本轮预载未找到可用音源");
        Resolved value;
        synchronized (resolved) { value = resolved.get(key); }
        if (value != null && value.expires > android.os.SystemClock.elapsedRealtime()) {
            return spec.buildUpon().setUri(value.uri).setKey(value.cacheKey).build();
        }
        JSONObject track = tracks.get(key);
        if (track == null) throw new IOException("曲目已移出播放队列");
        String quality = key.substring(key.lastIndexOf(':') + 1);
        String requestId = UUID.randomUUID().toString();
        int version = preferencesVersion;
        try {
            Object response = NodeRuntime.invoke("android:resolve",
                new JSONArray().put(track).put(quality).put(preferences).put(requestId)).get(60, TimeUnit.SECONDS);
            JSONObject result = (JSONObject) response;
            // 试听使用独立缓存身份，每次播放仍先经过选源与试听权限检查
            String actualKey = cacheKey(track, result.getString("cacheQuality"))
                + (result.optBoolean("isTrial") ? ":trial" : "");
            value = new Resolved(result.getString("url"), result.optString("pluginId", null),
                actualKey);
            String scheme = value.uri.getScheme();
            if (!"https".equals(scheme) && !"http".equals(scheme)) throw new IOException("音源不是 HTTP 地址");
            synchronized (resolved) {
                if (version != preferencesVersion || Thread.currentThread().isInterrupted())
                    throw new IOException("音源解析已取消");
                resolved.put(key, value);
                while (resolved.size() > 4) resolved.remove(resolved.keySet().iterator().next());
            }
            return spec.buildUpon().setUri(value.uri).setKey(value.cacheKey).build();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IOException("音源解析已取消", error);
        } catch (Exception error) {
            throw new IOException("音源解析失败", error);
        } finally {
            NodeRuntime.publish("android:cancelSource", requestId);
        }
    }

    /**
     * 读取当前实际缓存身份，降级内容不能冒充用户请求的高档音质
     * @param key - 队列中的请求身份
     * @return 当前文件的缓存键，完整缓存命中时保留原键
     */
    String playbackCacheKey(String key) {
        synchronized (resolved) {
            Resolved value = resolved.get(key);
            return value == null ? key : value.cacheKey;
        }
    }

    /**
     * 当前音源成功加载后仅消费一次插件标识，缓存播放和重复状态通知不计数
     * @param key - 已完成加载的曲目缓存键
     * @return 尚未记录的插件标识，无插件解析结果时返回 null
     */
    String takeLoadedPlugin(String key) {
        synchronized (resolved) {
            Resolved value = resolved.get(key);
            if (value == null || value.reported) return null;
            value.reported = true;
            return value.pluginId;
        }
    }

    /**
     * 网络地址失效后允许重新解析
     * @param key - 当前曲目的缓存键
     */
    void invalidate(String key) {
        synchronized (resolved) { resolved.remove(key); }
    }
}
