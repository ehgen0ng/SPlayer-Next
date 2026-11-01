package top.imsyy.splayer.car;

import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.HttpUtil;
import androidx.media3.datasource.StatsDataSource;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.source.TrackGroupArray;
import androidx.media3.inspector.MetadataRetriever;
import com.getcapacitor.JSObject;
import java.io.IOException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** 只提取音轨参数，不占用播放器、播放队列或歌曲缓存 */
@UnstableApi
final class AudioProbe {
    /**
     * 将 Media3 音轨参数映射到共享音质类型
     * @param format - 提取或播放得到的原始音轨格式
     * @param bytes - 实际文件字节数，未知时为负数
     * @param durationMs - 实际时长，单位毫秒
     * @return 供两端共享音质比较器消费的参数
     */
    static JSObject quality(Format format, long bytes, long durationMs) {
        String mime = format.sampleMimeType == null ? "unknown" : format.sampleMimeType;
        String codec = mime.equals("audio/raw") ? "wav" : mime.equals("audio/mpeg") ? "mp3"
            : mime.equals("audio/mp4a-latm") ? "aac" : mime.replace("audio/", "");
        int bits = format.pcmEncoding == C.ENCODING_PCM_16BIT ? 16 : format.pcmEncoding == C.ENCODING_PCM_24BIT ? 24
            : format.pcmEncoding == C.ENCODING_PCM_32BIT || format.pcmEncoding == C.ENCODING_PCM_FLOAT ? 32 : 0;
        long bitRate = Math.max(0, format.bitrate);
        if (bitRate == 0 && durationMs > 0 && bytes > 0) bitRate = Math.round(bytes * 8000.0 / durationMs);
        return new JSObject().put("sampleRate", Math.max(0, format.sampleRate))
            .put("channels", Math.max(0, format.channelCount)).put("bitsPerSample", bits)
            .put("bitRate", bitRate).put("codec", codec);
    }

    /**
     * 独立读取音质、歌手标签和时长，完成或失败后立即释放检索器
     * @param url - 已由插件或官方接口解析的音频地址
     * @return 与桌面 probeSource 相同的响应结构
     */
    static CompletableFuture<Object> inspect(String url) {
        CompletableFuture<Object> result = new CompletableFuture<>();
        new Thread(() -> {
            StatsDataSource data = new StatsDataSource(new DefaultHttpDataSource.Factory()
                .setConnectTimeoutMs(15_000).setReadTimeoutMs(15_000)
                .setAllowCrossProtocolRedirects(true).createDataSource());
            try (MetadataRetriever retriever = new MetadataRetriever.Builder(null, MediaItem.fromUri(url))
                .setMediaSourceFactory(new DefaultMediaSourceFactory(() -> data, new DefaultExtractorsFactory())).build()) {
                TrackGroupArray groups = retriever.retrieveTrackGroups().get(20, TimeUnit.SECONDS);
                long durationUs = retriever.retrieveDurationUs().get(20, TimeUnit.SECONDS);
                long duration = durationUs > 0 ? durationUs / 1000 : 0;
                for (int index = 0; index < groups.length; index++) {
                    Format format = groups.get(index).getFormat(0);
                    if (!MimeTypes.isAudio(format.sampleMimeType)) continue;
                    String length = null;
                    String range = null;
                    for (var header : data.getLastResponseHeaders().entrySet()) {
                        if (header.getValue().isEmpty()) continue;
                        if (header.getKey().equalsIgnoreCase("Content-Length")) length = header.getValue().get(0);
                        if (header.getKey().equalsIgnoreCase("Content-Range")) range = header.getValue().get(0);
                    }
                    long bytes = range == null ? HttpUtil.getContentLength(length, null) : HttpUtil.getDocumentSize(range);
                    MediaMetadata.Builder metadata = new MediaMetadata.Builder();
                    if (format.metadata != null) metadata.populateFromMetadata(format.metadata);
                    CharSequence artist = metadata.build().artist;
                    JSObject info = quality(format, bytes, duration).put("duration", duration);
                    if (artist != null) info.put("artist", artist.toString());
                    result.complete(new JSObject().put("success", true)
                        .put("data", info));
                    return;
                }
                throw new IOException("文件中没有音轨");
            } catch (Exception error) {
                result.complete(new JSObject().put("success", false).put("error", error.getMessage()));
            }
        }, "splayer-source-probe").start();
        return result;
    }
}
