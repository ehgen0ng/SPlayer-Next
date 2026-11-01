package top.imsyy.splayer.car;

import android.content.Context;
import android.os.Handler;
import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.common.Timeline;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.LoadControl;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.source.preload.DefaultPreloadManager;
import androidx.media3.exoplayer.source.preload.PreloadException;
import androidx.media3.exoplayer.source.preload.PreloadManagerListener;
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.IntPredicate;
import java.util.function.IntUnaryOperator;

/** 按原生队列逐首寻找可预载音源，失败记录仅保留到本轮播放上下文结束 */
@UnstableApi
final class NextTrackPreloader implements Player.Listener, PreloadManagerListener {
    private final ExoPlayer player;
    private final SourceResolver resolver;
    private final DefaultPreloadManager manager;
    private final Handler handler;
    private final Set<String> unavailable = new HashSet<>();
    private boolean enabled;
    private boolean released;
    private int generation;
    private int cursor;
    private String anchorId = "";
    @Nullable private MediaItem target;

    /**
     * 共用当前播放器的加载优先级与磁盘缓存，仅保留一个五秒预载任务
     * @param context - 服务上下文
     * @param player - 队列唯一所有者
     * @param data - 已接入选源与缓存的数据源
     * @param loadControl - 当前播放优先的共享加载控制器
     * @param resolver - 复用成功地址并阻止本轮失败音源重复请求
     */
    NextTrackPreloader(Context context, ExoPlayer player, DataSource.Factory data,
        LoadControl loadControl, SourceResolver resolver) {
        this.player = player;
        this.resolver = resolver;
        handler = new Handler(player.getApplicationLooper());
        DefaultMediaSourceFactory sources = new DefaultMediaSourceFactory(data)
            .setLoadErrorHandlingPolicy(new DefaultLoadErrorHandlingPolicy() {
                /**
                 * 共享选源已尝试插件与音质降级，预载失败后直接换候选
                 * @param error - 本次加载失败信息
                 * @return 不在同一候选上继续重试
                 */
                @Override public long getRetryDelayMsFor(LoadErrorInfo error) { return C.TIME_UNSET; }
            });
        manager = new DefaultPreloadManager.Builder(context,
            index -> DefaultPreloadManager.PreloadStatus.specifiedRangeLoaded(5_000))
            .setMediaSourceFactory(sources).setLoadControl(loadControl)
            .setPreloadLooper(player.getPlaybackLooper()).build();
        manager.addListener(this);
        player.addListener(this);
    }

    /**
     * 应用预载开关，关闭时释放任务和本轮失败记录
     * @param value - 是否预载下一首
     */
    void setEnabled(boolean value) {
        if (enabled == value) return;
        enabled = value;
        restart();
    }

    /** 清除旧队列和旧设置的预载结果，用户主动选歌时允许重新尝试 */
    void reset() {
        generation++;
        manager.reset();
        unavailable.clear();
        resolver.clearPreloadFailures();
        target = null;
        MediaItem current = player.getCurrentMediaItem();
        anchorId = current == null ? "" : current.mediaId;
        cursor = player.getCurrentMediaItemIndex();
    }

    /** 从更新后的播放上下文开始新一轮预载 */
    private void restart() {
        reset();
        advance();
    }

    /** 当前播放缓冲充足后，沿真实播放顺序预载下一首尚未失败的歌曲 */
    private void advance() {
        if (released || !enabled || target != null || player.getPlaybackState() != Player.STATE_READY
            || player.isLoading() || player.getCurrentMediaItem() == null) return;
        Timeline timeline = player.getCurrentTimeline();
        int repeat = player.getRepeatMode() == Player.REPEAT_MODE_ONE
            ? Player.REPEAT_MODE_OFF : player.getRepeatMode();
        int next = nextIndex(cursor, timeline.getWindowCount(),
            index -> timeline.getNextWindowIndex(index, repeat, player.getShuffleModeEnabled()),
            index -> {
                String id = player.getMediaItemAt(index).mediaId;
                return id.equals(anchorId) || unavailable.contains(id);
            });
        if (next == C.INDEX_UNSET) return;
        cursor = next;
        target = player.getMediaItemAt(next);
        manager.addMediaItems(List.of(target), List.of(next));
    }

    /**
     * 从给定位置继续扫描，循环队列最多经过每个位置一次
     * @param from - 本轮已处理的位置
     * @param count - 队列长度，作为自然终点而非固定尝试次数
     * @param next - 原生队列的顺序或随机后继
     * @param unavailable - 本轮不能选择的位置
     * @return 下一候选位置，没有候选时返回 INDEX_UNSET
     */
    static int nextIndex(int from, int count, IntUnaryOperator next, IntPredicate unavailable) {
        int index = from;
        for (int visited = 0; visited < count; visited++) {
            index = next.applyAsInt(index);
            if (index == C.INDEX_UNSET || index == from) return C.INDEX_UNSET;
            if (!unavailable.test(index)) return index;
        }
        return C.INDEX_UNSET;
    }

    /**
     * 手动下一首和自动跳过共用本轮失败记录，不改变队列内容
     * @return 下一可尝试位置，整轮均不可用时返回 INDEX_UNSET
     */
    int nextPlayableIndex() {
        if (unavailable.isEmpty()) return player.getNextMediaItemIndex();
        Timeline timeline = player.getCurrentTimeline();
        int repeat = player.getRepeatMode() == Player.REPEAT_MODE_ONE
            ? Player.REPEAT_MODE_OFF : player.getRepeatMode();
        return nextIndex(player.getCurrentMediaItemIndex(), timeline.getWindowCount(),
            index -> timeline.getNextWindowIndex(index, repeat, player.getShuffleModeEnabled()),
            index -> {
                String id = player.getMediaItemAt(index).mediaId;
                return id.equals(anchorId) || unavailable.contains(id);
            });
    }

    /**
     * 正式切歌遇到本轮已失败的曲目时直接顺延，避免再次等待同一轮找源
     * @return 是否已处理已知失败曲目
     */
    boolean skipKnownUnavailable() {
        MediaItem current = player.getCurrentMediaItem();
        if (current == null || !unavailable.contains(current.mediaId)) return false;
        int next = nextPlayableIndex();
        if (next == C.INDEX_UNSET) player.pause();
        else {
            player.seekTo(next, 0);
            player.prepare();
        }
        return true;
    }

    /**
     * 预载完成后保留缓存和地址，释放五秒样本，避免重复占用内存
     * @param item - 已完成的候选
     */
    @Override public void onCompleted(MediaItem item) {
        int version = generation;
        handler.post(() -> {
            if (!released && version == generation && target != null && target.mediaId.equals(item.mediaId))
                manager.reset();
        });
    }

    /**
     * 预载失败只推进后台候选，不打断当前播放，也不删除队列曲目
     * @param error - 失败曲目及原因
     */
    @Override public void onError(PreloadException error) {
        int version = generation;
        handler.post(() -> {
            if (released || version != generation || target == null
                || !target.mediaId.equals(error.mediaItem.mediaId)) return;
            unavailable.add(target.mediaId);
            resolver.markPreloadFailure(target.localConfiguration.customCacheKey);
            manager.reset();
            target = null;
            advance();
        });
    }

    /**
     * 队列修改会取消旧轮次，音频时长更新不触发重复找源
     * @param timeline - 当前原生队列
     * @param reason - 队列变化原因
     */
    @Override public void onTimelineChanged(Timeline timeline, int reason) {
        if (reason == Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED) restart();
    }

    /**
     * 自然切入失败项时保留记录，交由错误事件顺延；主动选择开始新一轮
     * @param item - 当前曲目
     * @param reason - 切歌原因
     */
    @Override public void onMediaItemTransition(@Nullable MediaItem item, int reason) {
        if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO && item != null
            && unavailable.contains(item.mediaId)) return;
        restart();
    }

    /**
     * 按更新后的随机顺序重新选取预载候选
     * @param shuffle - 是否随机播放
     */
    @Override public void onShuffleModeEnabledChanged(boolean shuffle) { restart(); }

    /**
     * 循环模式改变后重新确定本轮队列边界
     * @param repeat - 循环模式
     */
    @Override public void onRepeatModeChanged(int repeat) { restart(); }

    /**
     * 当前曲目可播后才允许预载，主动停止时释放后台工作
     * @param state - 原生播放状态
     */
    @Override public void onPlaybackStateChanged(int state) {
        if (state == Player.STATE_IDLE && player.getPlayerError() == null) reset();
        else if (state == Player.STATE_READY) advance();
    }

    /**
     * 当前播放完成缓冲后启动等待中的预载
     * @param loading - 当前播放器是否仍在加载
     */
    @Override public void onIsLoadingChanged(boolean loading) {
        if (!loading) advance();
    }

    /** 结束服务时取消预载并释放工作线程，清除当前轮次的失败记录 */
    void release() {
        released = true;
        generation++;
        handler.removeCallbacksAndMessages(null);
        player.removeListener(this);
        manager.release();
        unavailable.clear();
        resolver.clearPreloadFailures();
    }
}
