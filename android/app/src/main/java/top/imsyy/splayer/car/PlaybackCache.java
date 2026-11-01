package top.imsyy.splayer.car;

import android.content.Context;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.database.StandaloneDatabaseProvider;
import androidx.media3.datasource.cache.Cache;
import androidx.media3.datasource.cache.CacheEvictor;
import androidx.media3.datasource.cache.CacheSpan;
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor;
import androidx.media3.datasource.cache.SimpleCache;
import java.io.File;

/** 使用 Media3 的 LRU 缓存，仅包装其容量调整，不维护第二套缓存索引 */
@UnstableApi
final class PlaybackCache implements CacheEvictor {
    final SimpleCache cache;
    private LeastRecentlyUsedCacheEvictor delegate;
    private long limit;

    /**
     * 打开应用私有播放缓存
     * @param context - 应用上下文
     * @param bytes - 容量上限
     */
    PlaybackCache(Context context, long bytes) {
        limit = bytes;
        delegate = new LeastRecentlyUsedCacheEvictor(bytes);
        cache = new SimpleCache(new File(context.getFilesDir(), "app-data/cache/audio"), this,
            new StandaloneDatabaseProvider(context));
    }

    /**
     * 通过重建标准驱逐器应用容量变更，播放器继续使用同一缓存实例
     * @param bytes - 新的容量上限
     */
    void setLimit(long bytes) {
        if (bytes <= 0) throw new IllegalArgumentException("缓存容量必须大于零");
        synchronized (cache) {
            if (limit == bytes) return;
            limit = bytes;
            delegate = new LeastRecentlyUsedCacheEvictor(bytes);
            for (String key : cache.getKeys()) {
                for (CacheSpan span : cache.getCachedSpans(key)) delegate.onSpanAdded(cache, span);
            }
        }
    }

    /** 清理已缓存的音频片段，后续读取缺失部分时自动联网 */
    void clear() {
        synchronized (cache) {
            for (String key : cache.getKeys()) cache.removeResource(key);
        }
    }

    /**
     * 保留标准 LRU 所需的访问时间更新
     * @return 是否记录访问时间
     */
    @Override public boolean requiresCacheSpanTouches() { return true; }

    /** 完成缓存初始化通知 */
    @Override public void onCacheInitialized() { delegate.onCacheInitialized(); }

    /**
     * 开始写入时交由标准 LRU 腾出空间
     * @param source - 当前缓存
     * @param key - 缓存键
     * @param position - 片段起点
     * @param length - 片段长度
     */
    @Override public void onStartFile(Cache source, String key, long position, long length) {
        delegate.onStartFile(source, key, position, length);
    }

    /**
     * 记录新增缓存片段
     * @param source - 当前缓存
     * @param span - 新片段
     */
    @Override public void onSpanAdded(Cache source, CacheSpan span) { delegate.onSpanAdded(source, span); }

    /**
     * 移除已删除的片段
     * @param source - 当前缓存
     * @param span - 删除的片段
     */
    @Override public void onSpanRemoved(Cache source, CacheSpan span) { delegate.onSpanRemoved(source, span); }

    /**
     * 更新片段访问时间
     * @param source - 当前缓存
     * @param oldSpan - 原片段
     * @param newSpan - 更新后的片段
     */
    @Override public void onSpanTouched(Cache source, CacheSpan oldSpan, CacheSpan newSpan) {
        delegate.onSpanTouched(source, oldSpan, newSpan);
    }
}
