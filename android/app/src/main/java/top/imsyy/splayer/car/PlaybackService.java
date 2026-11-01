package top.imsyy.splayer.car;

import android.app.PendingIntent;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Binder;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.ResolvingDataSource;
import androidx.media3.datasource.cache.CacheDataSource;
import androidx.media3.datasource.cache.ContentMetadata;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.DecoderCounters;
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.exoplayer.analytics.PlayerId;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;
import androidx.media3.exoplayer.audio.TeeAudioProcessor;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import org.json.JSONArray;
import org.json.JSONObject;

/** Media3 持有唯一播放队列，WebView 关闭后仍可解析音源并自动切歌 */
@UnstableApi
public final class PlaybackService extends MediaSessionService {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final LocalBinder binder = new LocalBinder();
    private SourceResolver resolver;
    private NextTrackPreloader preloader;
    private ExoPlayer player;
    @Nullable private AudioSink.AudioTrackConfig audioTrackConfig;
    private MediaSession session;
    private PlaybackCache cache;
    private SharedPreferences saved;
    private NativePlatform platform;
    private BydVoice bydVoice;
    private boolean visible;
    private String quality = "hq";
    private int consecutiveFailures;
    private String retriedMediaId;
    private String mode = "queue";
    private JSONObject fmOptions = new JSObject().put("mode", "DEFAULT");
    private int modeEpoch;
    private boolean fillingFm;
    private final SpectrumSink spectrum = new SpectrumSink();
    private boolean fftRequested;
    private final Runnable spectrumTick = new Runnable() {
        /** 仅在前台且有消费者时计算并推送频谱 */
        @Override public void run() {
            if (!visible || !fftRequested) return;
            double[][] frame = spectrum.sample();
            JSONArray left = new JSONArray(), right = new JSONArray();
            for (double value : frame[0]) left.put((Object) value);
            for (double value : frame[1]) right.put((Object) value);
            NodeRuntime.publish("player:event", new JSObject().put("type", "fftData").put("data",
                new JSObject().put("ldata", left).put("rdata", right)));
            main.postDelayed(this, 50);
        }
    };

    public final class LocalBinder extends Binder {
        /**
         * 获取应用内服务，平台媒体控制仍经过 MediaSession
         * @return 当前服务
         */
        public PlaybackService getService() { return PlaybackService.this; }
    }

    private final Runnable tick = new Runnable() {
        /** 仅向可见界面发送高频进度 */
        @Override public void run() {
            if (!visible) return;
            NodeRuntime.publish("android:playback", snapshot());
            main.postDelayed(this, 200);
        }
    };
    private final Runnable checkpoint = new Runnable() {
        /** 定期保存原生播放位置，供进程重建恢复 */
        @Override public void run() {
            savePosition();
            main.postDelayed(this, 10_000);
        }
    };
    private final Runnable memorySample = new Runnable() {
        /** 按桌面相同节奏记录应用进程内存 */
        @Override public void run() {
            android.os.Debug.MemoryInfo memory = new android.os.Debug.MemoryInfo();
            android.os.Debug.getMemoryInfo(memory);
            Log.i("SPlayer", "memory pssKiB=" + memory.getTotalPss() + " visible=" + visible);
            main.postDelayed(this, 600_000);
        }
    };

    /** 创建后台播放资源并恢复暂停状态，避免启动应用时意外出声 */
    @Override public void onCreate() {
        super.onCreate();
        saved = getSharedPreferences("playback", MODE_PRIVATE);
        quality = saved.getString("quality", "hq");
        mode = saved.getString("mode", "queue");
        cache = new PlaybackCache(this, saved.getLong("cacheLimit", 2L * 1024 * 1024 * 1024));
        resolver = new SourceResolver(cache.cache);
        platform = new NativePlatform(this);
        ResolvingDataSource.Factory data = new ResolvingDataSource.Factory(
            new CacheDataSource.Factory().setCache(cache.cache)
                .setUpstreamDataSourceFactory(new DefaultHttpDataSource.Factory().setUserAgent("SPlayer-Next")
                    .setAllowCrossProtocolRedirects(true))
                .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR), resolver);
        DefaultRenderersFactory renderers = new DefaultRenderersFactory(this) {
            /**
             * 在应用自身的 PCM 输出链中旁路取样
             * @param context - 播放上下文
             * @param floatOutput - 是否请求浮点输出
             * @param playbackParameters - 是否使用平台速度控制
             * @return 保持 Media3 标准处理链的音频输出
             */
            @Override protected AudioSink buildAudioSink(android.content.Context context, boolean floatOutput, boolean playbackParameters) {
                return new DefaultAudioSink.Builder(context)
                    .setAudioProcessors(new AudioProcessor[] { new TeeAudioProcessor(spectrum) })
                    .setEnableAudioOutputPlaybackParameters(playbackParameters).build();
            }
        };
        DefaultLoadControl loadControl = new DefaultLoadControl() {
            private boolean playbackNeedsLoading;

            /**
             * 当前播放需要补缓冲时暂停后台预载，共用播放线程避免状态竞争
             * @param parameters - 当前加载请求及所属播放器
             * @return 是否继续读取音频
             */
            @Override public boolean shouldContinueLoading(Parameters parameters) {
                if (parameters.playerId.equals(PlayerId.PRELOAD))
                    return !playbackNeedsLoading && super.shouldContinueLoading(parameters);
                playbackNeedsLoading = super.shouldContinueLoading(parameters);
                return playbackNeedsLoading;
            }
        };
        player = new ExoPlayer.Builder(this, renderers)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(data))
            .setLoadControl(loadControl)
            .setAudioAttributes(new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setHandleAudioBecomingNoisy(true).setWakeMode(C.WAKE_MODE_NETWORK).build();
        preloader = new NextTrackPreloader(this, player, data, loadControl, resolver);
        player.addAnalyticsListener(new AnalyticsListener() {
            /**
             * 记录真正创建的应用输出流格式，不推断系统混音后的硬件参数
             * @param eventTime - 音频事件时间
             * @param config - 当前 AudioTrack 配置
             */
            @Override public void onAudioTrackInitialized(EventTime eventTime, AudioSink.AudioTrackConfig config) {
                audioTrackConfig = config;
            }

            /**
             * 音频渲染器停用后丢弃旧输出流格式
             * @param eventTime - 音频事件时间
             * @param counters - 已释放渲染器的统计
             */
            @Override public void onAudioDisabled(EventTime eventTime, DecoderCounters counters) {
                audioTrackConfig = null;
            }
        });
        player.setRepeatMode(mode.equals("fm") ? Player.REPEAT_MODE_OFF : saved.getBoolean("repeatOne", false) ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_ALL);
        player.setShuffleModeEnabled(saved.getBoolean("shuffle", false));
        player.setVolume(saved.getFloat("volume", 1f));
        player.setPlaybackSpeed(saved.getFloat("speed", 1f));
        try {
            fmOptions = new JSONObject(saved.getString("fmOptions", fmOptions.toString()));
            resolver.updatePreferences(new JSONObject(saved.getString("preferences", resolver.preferences.toString())));
            preloader.setEnabled(resolver.preferences.optBoolean("preloadNextTrack", true));
            JSONArray entries = new JSONArray(saved.getString("queue", "[]"));
            ArrayList<MediaItem> items = new ArrayList<>();
            for (int i = 0; i < entries.length(); i++) items.add(item(entries.getJSONObject(i)));
            if (!items.isEmpty()) player.setMediaItems(items,
                Math.max(0, Math.min(items.size() - 1, saved.getInt("index", 0))),
                saved.getLong("position", 0));
        } catch (Exception error) {
            Log.e("SPlayer", "恢复队列失败", error);
        }
        player.addListener(new Player.Listener() {
            /**
             * 将原生变化同步给共享业务和界面
             * @param current - 当前播放器
             * @param events - 本批变化
             */
            @Override public void onEvents(Player current, Player.Events events) {
                MediaItem item = current.getCurrentMediaItem();
                if (current.getPlaybackState() == Player.STATE_READY && item != null) {
                    String pluginId = resolver.takeLoadedPlugin(item.localConfiguration.customCacheKey);
                    if (pluginId != null) NodeRuntime.publish("android:sourceLoaded", pluginId);
                }
                if (events.contains(Player.EVENT_TIMELINE_CHANGED)) {
                    saveQueue();
                    NodeRuntime.publish("android:queue", entries());
                }
                savePosition();
                NodeRuntime.publish("android:playback", snapshot());
            }

            /**
             * 自然切歌和单曲循环由 Media3 执行，同时通知统计结算
             * @param mediaItem - 新曲目
             * @param reason - 切换原因
             */
            @Override public void onMediaItemTransition(@Nullable MediaItem mediaItem, int reason) {
                if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT) {
                    NodeRuntime.publish("android:roundEnded", snapshot());
                }
                retriedMediaId = null;
                refillFm();
            }

            /**
             * 实际开始输出后重置失败计数
             * @param playing - 是否实际播放
             */
            @Override public void onIsPlayingChanged(boolean playing) {
                if (playing) consecutiveFailures = 0;
            }

            /**
             * 失效地址重取一次，连续失败有界停止
             * @param error - 原生播放错误
             */
            @Override public void onPlayerError(PlaybackException error) {
                if (preloader.skipKnownUnavailable()) return;
                MediaItem current = player.getCurrentMediaItem();
                NodeRuntime.publish("android:error", error.getMessage());
                if (current == null) return;
                if (!current.mediaId.equals(retriedMediaId)) {
                    retriedMediaId = current.mediaId;
                    resolver.invalidate(current.localConfiguration.customCacheKey);
                    player.prepare();
                } else if (++consecutiveFailures < Math.min(5, player.getMediaItemCount())) {
                    player.seekToNextMediaItem();
                    player.prepare();
                } else player.pause();
            }
        });
        Intent launch = new Intent(this, MainActivity.class);
        session = new MediaSession.Builder(this, player).setSessionActivity(
            PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)
        ).build();
        addSession(session);
        NodeRuntime.setNativeHandler(this::invoke);
        NodeRuntime.start(this).thenCompose(ignored -> NodeRuntime.invoke("android:initialize", new JSONArray()))
            .exceptionally(error -> { Log.e("SPlayer", "共享业务启动失败", error); return null; });
        bydVoice = new BydVoice(this, player);
        bydVoice.register();
        main.post(checkpoint);
        main.postDelayed(memorySample, 60_000);
    }

    /**
     * 为标准媒体控制器提供系统会话
     * @param controllerInfo - 系统或应用控制器
     * @return 当前媒体会话
     */
    @Override public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) { return session; }

    /**
     * 应用内部绑定使用本地接口，其余控制器保留 Media3 协议
     * @param intent - 绑定意图
     * @return 对应绑定对象
     */
    @Override public IBinder onBind(Intent intent) {
        return "splayer:local".equals(intent.getAction()) ? binder : super.onBind(intent);
    }

    /**
     * 把已识别的厂商广播交给唯一播放器的语音适配器
     * @param intent - 比亚迪注册、查询或控制广播
     * @return 指令处理完成的信号
     */
    CompletableFuture<Void> handleBydIntent(Intent intent) {
        return bydVoice.handleIntent(intent);
    }

    /**
     * 读取界面最后选择的搜索平台，后台和进程重建沿用同一偏好
     * @return 平台标识
     */
    String voiceSearchPlatform() { return resolver.preferences.optString("searchPlatform", "netease"); }

    /**
     * 更新界面可见性，返回前台立即发送权威状态
     * @param value - 是否有可见界面
     */
    void setVisible(boolean value) {
        visible = value;
        main.removeCallbacks(tick);
        updateSpectrum();
        if (value) {
            NodeRuntime.publish("android:queue", entries());
            NodeRuntime.publish("android:playback", snapshot());
            NodeRuntime.publish("android:historyChanged", JSONObject.NULL);
            main.postDelayed(tick, 200);
        }
    }

    /** 同步频谱采样与推送生命周期，隐藏时不占用分析计算 */
    private void updateSpectrum() {
        main.removeCallbacks(spectrumTick);
        spectrum.setEnabled(visible && fftRequested);
        if (visible && fftRequested) main.post(spectrumTick);
    }

    /** 在原生队列接近末尾时续推 FM，异步结果不得覆盖用户后来选择的队列 */
    private void refillFm() {
        if (!mode.equals("fm") || fillingFm || player.getMediaItemCount() - player.getCurrentMediaItemIndex() > 2) return;
        fillingFm = true;
        int epoch = modeEpoch;
        NodeRuntime.invoke("fm:more", new JSONArray().put(fmOptions)).whenComplete((value, error) -> main.post(() -> {
            if (epoch != modeEpoch) return;
            fillingFm = false;
            if (error != null) { NodeRuntime.publish("android:error", error.getMessage()); return; }
            try {
                JSONArray tracks = (JSONArray) value;
                Set<String> seen = new HashSet<>();
                for (int i = 0; i < player.getMediaItemCount(); i++) {
                    JSONObject entry = (JSONObject) player.getMediaItemAt(i).localConfiguration.tag;
                    seen.add(entry.getJSONObject("track").getString("id"));
                }
                ArrayList<MediaItem> fresh = new ArrayList<>();
                for (int i = 0; i < tracks.length(); i++) {
                    JSONObject track = tracks.getJSONObject(i);
                    if (seen.add(track.getString("id"))) fresh.add(item(new JSObject().put("track", track)));
                }
                player.addMediaItems(fresh);
                int completed = player.getCurrentMediaItemIndex();
                if (completed > 0) player.removeMediaItems(0, completed);
            } catch (Exception failure) { NodeRuntime.publish("android:error", failure.getMessage()); }
        }));
    }

    /**
     * 切换播放模式并使在途推荐失效
     * @param next - 新播放模式
     */
    private void setMode(String next) {
        boolean wasFm = mode.equals("fm");
        modeEpoch++;
        fillingFm = false;
        mode = next;
        if (!mode.equals("queue")) player.setShuffleModeEnabled(false);
        if (mode.equals("fm")) player.setRepeatMode(Player.REPEAT_MODE_OFF);
        else if (wasFm || mode.equals("heart")) player.setRepeatMode(Player.REPEAT_MODE_ALL);
        savePosition();
    }

    /**
     * 将轻量队列条目附在 MediaItem，Media3 是队列唯一所有者
     * @param entry - 曲目及播放来源
     * @return 可由后台懒解析的媒体项
     */
    private MediaItem item(JSONObject entry) throws Exception {
        JSONObject track = entry.getJSONObject("track");
        String source = track.getString("source");
        if (source.equals("local") || source.equals("streaming")) throw new IllegalArgumentException("安卓车机仅支持在线音源");
        String key = SourceResolver.cacheKey(track, quality);
        resolver.tracks.put(key, track);
        JSONArray artists = track.optJSONArray("artists");
        ArrayList<String> names = new ArrayList<>();
        if (artists != null) for (int i = 0; i < artists.length(); i++) names.add(artists.getJSONObject(i).optString("name"));
        MediaMetadata.Builder metadata = new MediaMetadata.Builder().setTitle(track.optString("title"))
            .setArtist(String.join(" / ", names));
        JSONObject album = track.optJSONObject("album");
        if (album != null) metadata.setAlbumTitle(album.optString("name"));
        String cover = track.optString("cover");
        if (cover.startsWith("https://") || cover.startsWith("http://")) metadata.setArtworkUri(Uri.parse(cover));
        return new MediaItem.Builder().setMediaId(UUID.randomUUID().toString())
            .setUri("https://splayer.invalid/" + Uri.encode(key)).setCustomCacheKey(key)
            .setTag(entry).setMediaMetadata(metadata.build()).build();
    }

    /**
     * 读取 Media3 当前持有的轻量条目，不复制歌词与详情
     * @return 当前队列
     */
    private JSONArray entries() {
        JSONArray values = new JSONArray();
        for (int i = 0; i < player.getMediaItemCount(); i++) values.put(player.getMediaItemAt(i).localConfiguration.tag);
        return values;
    }

    /**
     * 读取毫秒单位的权威播放状态
     * @return 播放快照
     */
    JSObject snapshot() {
        MediaItem item = player.getCurrentMediaItem();
        JSONObject entry = item == null ? null : (JSONObject) item.localConfiguration.tag;
        int state = player.getPlaybackState();
        String label = player.isPlaying() ? "playing" : state == Player.STATE_BUFFERING ? "loading"
            : state == Player.STATE_ENDED ? "stopped" : item == null ? "idle" : "paused";
        JSONObject track = entry == null ? null : entry.optJSONObject("track");
        long duration = player.getDuration();
        androidx.media3.common.Format format = player.getAudioFormat();
        Object audioQuality = JSONObject.NULL;
        if (format != null) {
            long bytes = item == null ? -1 : ContentMetadata.getContentLength(
                cache.cache.getContentMetadata(resolver.playbackCacheKey(item.localConfiguration.customCacheKey)));
            audioQuality = AudioProbe.quality(format, bytes, duration);
        }
        if (duration <= 0) duration = track == null ? 0 : track.optLong("duration");
        return new JSObject().put("state", label).put("position", player.getCurrentPosition())
            .put("duration", Math.max(0, duration)).put("volume", player.getVolume())
            .put("speed", player.getPlaybackParameters().speed).put("isFinished", state == Player.STATE_ENDED)
            .put("track", entry == null ? JSONObject.NULL : entry.opt("track"))
            .put("context", entry == null ? JSONObject.NULL : entry.opt("context"))
            .put("currentIndex", item == null ? -1 : player.getCurrentMediaItemIndex())
            .put("repeat", player.getRepeatMode() == Player.REPEAT_MODE_ONE ? "one" : "list")
            .put("shuffle", player.getShuffleModeEnabled() ? "on" : "off")
            .put("mode", mode).put("fmOptions", fmOptions)
            .put("audioQuality", audioQuality)
            .put("timestamp", System.currentTimeMillis());
    }

    /** 保存队列并丢弃不再被队列引用的音源元数据 */
    private void saveQueue() {
        saved.edit().putString("queue", entries().toString()).apply();
        Set<String> active = new HashSet<>();
        for (int i = 0; i < player.getMediaItemCount(); i++) active.add(player.getMediaItemAt(i).localConfiguration.customCacheKey);
        resolver.tracks.keySet().retainAll(active);
    }

    /** 保存恢复位置和模式，使用 Android 自带的异步合并写入 */
    private void savePosition() {
        saved.edit().putInt("index", player.getCurrentMediaItemIndex()).putLong("position", player.getCurrentPosition())
            .putFloat("volume", player.getVolume()).putFloat("speed", player.getPlaybackParameters().speed)
            .putBoolean("repeatOne", player.getRepeatMode() == Player.REPEAT_MODE_ONE)
            .putBoolean("shuffle", player.getShuffleModeEnabled()).putString("quality", quality)
            .putString("mode", mode).putString("fmOptions", fmOptions.toString())
            .putString("preferences", resolver.preferences.toString()).apply();
    }

    /**
     * 在服务主线程执行界面或 Node 提供的控制命令
     * @param channel - 既有 API 或安卓队列方法
     * @param args - 方法参数
     * @return 执行结果，未知平台能力转给真实平台实现
     */
    CompletableFuture<Object> invoke(String channel, JSONArray args) {
        CompletableFuture<Object> future = new CompletableFuture<>();
        main.post(() -> {
            try {
                if (bydVoice != null) bydVoice.onPlaybackCommand(channel);
                Object result = JSONObject.NULL;
                switch (channel) {
                    case "player:probeSource":
                        AudioProbe.inspect(args.getString(0)).whenComplete((value, error) -> {
                            if (error != null) future.completeExceptionally(error); else future.complete(value);
                        });
                        return;
                    case "android:snapshot": result = snapshot(); break;
                    case "android:queue": result = entries(); break;
                    case "android:getQueue": {
                        JSONObject options = args.optJSONObject(0);
                        int offset = Math.max(0, options == null ? 0 : options.optInt("offset"));
                        int limit = Math.min(1000, Math.max(1, options == null ? 100 : options.optInt("limit", 100)));
                        JSONArray tracks = new JSONArray();
                        for (int i = offset; i < Math.min(offset + limit, player.getMediaItemCount()); i++) {
                            tracks.put(((JSONObject) player.getMediaItemAt(i).localConfiguration.tag).get("track"));
                        }
                        result = new JSObject().put("tracks", tracks).put("total", player.getMediaItemCount())
                            .put("currentIndex", player.getCurrentMediaItemIndex()).put("offset", offset);
                        break;
                    }
                    case "android:replaceQueue": {
                        JSONArray input = args.getJSONArray(0);
                        ArrayList<MediaItem> items = new ArrayList<>();
                        for (int i = 0; i < input.length(); i++) items.add(item(input.getJSONObject(i)));
                        int index = args.optInt(1, 0);
                        setMode(args.optString(3, "queue"));
                        if (items.isEmpty()) player.clearMediaItems();
                        else {
                            if (index < 0 || index >= items.size()) throw new IllegalArgumentException("队列索引无效");
                            player.setMediaItems(items, index, 0);
                            player.prepare();
                            player.setPlayWhenReady(args.optBoolean(2, true));
                        }
                        break;
                    }
                    case "android:playAt": {
                        int index = args.getInt(0);
                        if (index < 0 || index >= player.getMediaItemCount()) throw new IllegalArgumentException("队列索引无效");
                        preloader.reset();
                        setMode("queue");
                        player.seekTo(index, 0);
                        player.prepare();
                        player.play();
                        break;
                    }
                    case "android:playTrack": {
                        setMode("queue");
                        MediaItem selected = item(new JSObject().put("track", args.getJSONObject(0)).put("context", args.opt(1)));
                        int index = player.getMediaItemCount() == 0 ? 0 : player.getCurrentMediaItemIndex() + 1;
                        player.addMediaItem(index, selected);
                        player.seekTo(index, 0);
                        player.prepare();
                        player.play();
                        break;
                    }
                    case "android:addToQueue": {
                        JSONArray tracks = args.getJSONArray(0);
                        ArrayList<MediaItem> items = new ArrayList<>();
                        for (int i = 0; i < tracks.length(); i++) items.add(item(new JSObject().put("track", tracks.get(i)).put("context", args.opt(2))));
                        int index = args.optString(1, "next").equals("end") ? player.getMediaItemCount()
                            : Math.min(player.getMediaItemCount(), player.getCurrentMediaItemIndex() + 1);
                        player.addMediaItems(index, items);
                        break;
                    }
                    case "android:insertAt": {
                        int index = Math.max(0, Math.min(player.getMediaItemCount(), args.getInt(1)));
                        player.addMediaItem(index, item(new JSObject().put("track", args.getJSONObject(0)).put("context", args.opt(2))));
                        break;
                    }
                    case "android:reload": {
                        MediaItem current = player.getCurrentMediaItem();
                        if (current != null) {
                            resolver.invalidate(current.localConfiguration.customCacheKey);
                            long position = player.getCurrentPosition();
                            player.replaceMediaItem(player.getCurrentMediaItemIndex(), item((JSONObject) current.localConfiguration.tag));
                            player.seekTo(position);
                            player.prepare();
                            if (!args.isNull(0)) player.setPlayWhenReady(args.getBoolean(0));
                        }
                        break;
                    }
                    case "android:removeFromQueue": player.removeMediaItem(args.getInt(0)); break;
                    case "android:moveInQueue": player.moveMediaItem(args.getInt(0), args.getInt(1)); break;
                    case "android:clearQueue": setMode("queue"); player.clearMediaItems(); break;
                    case "android:exitHeart": setMode("queue"); NodeRuntime.publish("android:playback", snapshot()); break;
                    case "android:startFm": {
                        JSONObject options = args.getJSONObject(0);
                        int epoch = ++modeEpoch;
                        fillingFm = false;
                        NodeRuntime.invoke("fm:more", new JSONArray().put(options)).whenComplete((value, error) -> main.post(() -> {
                            if (error != null) { future.completeExceptionally(error); return; }
                            if (epoch != modeEpoch) { future.complete(false); return; }
                            try {
                                JSONArray tracks = (JSONArray) value;
                                ArrayList<MediaItem> items = new ArrayList<>();
                                for (int i = 0; i < tracks.length(); i++) items.add(item(new JSObject().put("track", tracks.get(i))));
                                if (items.isEmpty()) { future.complete(false); return; }
                                fmOptions = options;
                                setMode("fm");
                                player.setMediaItems(items);
                                player.prepare();
                                player.play();
                                future.complete(true);
                            } catch (Exception failure) { future.completeExceptionally(failure); }
                        }));
                        return;
                    }
                    case "android:dislikeFm": {
                        if (!mode.equals("fm") || player.getCurrentMediaItem() == null) break;
                        JSONObject track = ((JSONObject) player.getCurrentMediaItem().localConfiguration.tag).getJSONObject("track");
                        NodeRuntime.invoke("fm:dislike", new JSONArray().put(track.getString("id")).put(player.getCurrentPosition() / 1000))
                            .exceptionally(error -> { NodeRuntime.publish("android:error", error.getMessage()); return null; });
                        player.seekToNextMediaItem();
                        refillFm();
                        break;
                    }
                    case "android:next": {
                        int next = preloader.nextPlayableIndex();
                        if (next == C.INDEX_UNSET) player.pause();
                        else {
                            player.seekTo(next, 0);
                            player.prepare();
                            player.setPlayWhenReady(args.optBoolean(0, true));
                        }
                        break;
                    }
                    case "android:prev": player.seekToPrevious(); player.prepare(); player.play(); break;
                    case "android:setRepeat": player.setRepeatMode(args.getString(0).equals("one") ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_ALL); break;
                    case "android:setShuffle": player.setShuffleModeEnabled(args.getString(0).equals("on")); break;
                    case "android:preferences": {
                        JSONObject preferences = args.getJSONObject(0);
                        String nextQuality = preferences.getString("quality");
                        if (!java.util.Arrays.asList("lq", "sq", "hq", "lossless", "hi-res").contains(nextQuality)) throw new IllegalArgumentException("音质无效");
                        boolean sourceChanged = resolver.updatePreferences(preferences);
                        preloader.setEnabled(preferences.optBoolean("preloadNextTrack", true));
                        if (sourceChanged || !quality.equals(nextQuality)) {
                            quality = nextQuality;
                            JSONArray previous = entries();
                            ArrayList<MediaItem> items = new ArrayList<>();
                            for (int i = 0; i < previous.length(); i++) items.add(item(previous.getJSONObject(i)));
                            int index = player.getCurrentMediaItemIndex();
                            long position = player.getCurrentPosition();
                            if (!items.isEmpty()) player.setMediaItems(items, index, position);
                        }
                        savePosition();
                        break;
                    }
                    case "player:play": player.prepare(); player.play(); refillFm(); result = new JSObject().put("success", true); break;
                    case "player:pause": player.pause(); result = new JSObject().put("success", true); break;
                    case "player:stop": player.stop(); result = new JSObject().put("success", true); break;
                    case "player:seek": player.seekTo(Math.max(0, args.getLong(0))); result = new JSObject().put("success", true); break;
                    case "player:setVolume": player.setVolume((float) Math.max(0, Math.min(1, args.getDouble(0)))); result = new JSObject().put("success", true); break;
                    case "player:setSpeed": player.setPlaybackSpeed((float) args.getDouble(0)); result = new JSObject().put("success", true); break;
                    case "player:getStatus": result = new JSObject().put("success", true).put("data", snapshot()); break;
                    case "player:getStreamInfo": {
                        JSONObject source = snapshot().optJSONObject("audioQuality");
                        AudioSink.AudioTrackConfig output = audioTrackConfig;
                        Object info = JSONObject.NULL;
                        if (source != null && output != null) {
                            int bits = output.encoding == C.ENCODING_PCM_8BIT ? 8
                                : output.encoding == C.ENCODING_PCM_16BIT ? 16
                                : output.encoding == C.ENCODING_PCM_24BIT ? 24
                                : output.encoding == C.ENCODING_PCM_32BIT || output.encoding == C.ENCODING_PCM_FLOAT ? 32 : 0;
                            float speed = player.getPlaybackParameters().speed;
                            info = new JSObject().put("deviceName", "").put("isExclusive", false)
                                .put("outputSampleRate", output.sampleRate).put("outputChannels", Integer.bitCount(output.channelConfig))
                                .put("outputBits", bits).put("sourceSampleRate", source.optInt("sampleRate"))
                                .put("sourceBits", source.optInt("bitsPerSample")).put("isResampling", JSONObject.NULL)
                                .put("isEqualizerActive", false).put("isTempoActive", speed != 1f).put("speed", speed)
                                .put("isNormalizationActive", false).put("isLimiterActive", false);
                        }
                        JSObject response = new JSObject().put("success", true);
                        if (info != JSONObject.NULL) response.put("data", info);
                        result = response;
                        break;
                    }
                    case "player:getSourceSize": {
                        MediaItem current = player.getCurrentMediaItem();
                        long size = C.LENGTH_UNSET;
                        if (current != null) {
                            JSONObject track = ((JSONObject) current.localConfiguration.tag).getJSONObject("track");
                            String source = "android://" + track.getString("source") + "/" + track.getString("id");
                            if (source.equals(args.getString(0))) {
                                size = ContentMetadata.getContentLength(cache.cache.getContentMetadata(resolver.playbackCacheKey(current.localConfiguration.customCacheKey)));
                            }
                        }
                        JSObject response = new JSObject().put("success", true);
                        if (size >= 0) response.put("data", size);
                        result = response;
                        break;
                    }
                    case "player:getVolume": result = new JSObject().put("success", true).put("data", player.getVolume()); break;
                    case "player:setFftEnabled": fftRequested = args.getBoolean(0); updateSpectrum(); result = new JSObject().put("success", true); break;
                    case "cache:setLimit": {
                        long bytes = args.getLong(0);
                        cache.setLimit(bytes);
                        saved.edit().putLong("cacheLimit", bytes).apply();
                        break;
                    }
                    case "cache:clear": cache.clear(); break;
                    case "cache:size": result = cache.cache.getCacheSpace(); break;
                    default:
                        platform.invoke(channel, args).whenComplete((value, error) -> {
                            if (error != null) future.completeExceptionally(error); else future.complete(value);
                        });
                        return;
                }
                future.complete(result);
            } catch (Exception error) { future.completeExceptionally(error); }
        });
        return future;
    }

    /** 结束服务时保存状态并释放播放器，Node 在应用进程内继续保持单实例 */
    @Override public void onDestroy() {
        bydVoice.close();
        savePosition();
        NodeRuntime.publish("android:serviceStopped", JSONObject.NULL);
        main.removeCallbacksAndMessages(null);
        NodeRuntime.setNativeHandler(null);
        preloader.release();
        session.release();
        player.release();
        cache.cache.release();
        platform.close();
        super.onDestroy();
    }
}
