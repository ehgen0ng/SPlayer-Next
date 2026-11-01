package top.imsyy.splayer.car;

import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.audio.TeeAudioProcessor;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.concurrent.locks.ReentrantLock;

/** 从本应用解码的 PCM 取样，不采集系统声音或麦克风 */
@UnstableApi
final class SpectrumSink implements TeeAudioProcessor.AudioBufferSink {
    private static final int SIZE = 2048;
    private static final int BINS = 128;
    private final ReentrantLock lock = new ReentrantLock();
    private final double[][] ring = new double[2][SIZE];
    private final double[][] real = new double[2][SIZE];
    private final double[] imaginary = new double[SIZE];
    private final double[] window = new double[SIZE];
    private int position;
    private int count;
    private int sampleRate = 48000;
    private int channels = 2;
    private int encoding = C.ENCODING_PCM_16BIT;
    private volatile boolean enabled;

    /** 预计算与桌面一致的 Hamming 窗 */
    SpectrumSink() {
        for (int i = 0; i < SIZE; i++) window[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (SIZE - 1));
    }

    /**
     * 隐藏或没有消费者时停止取样，恢复时丢弃旧帧
     * @param value - 是否需要频谱
     */
    void setEnabled(boolean value) {
        lock.lock();
        try { if (value != enabled) count = 0; enabled = value; }
        finally { lock.unlock(); }
    }

    /**
     * 切歌或跳转后清空旧采样并使用实际音频格式
     * @param rate - PCM 采样率
     * @param channelCount - 声道数
     * @param format - PCM 编码
     */
    @Override public void flush(int rate, int channelCount, int format) {
        lock.lock();
        try { sampleRate = rate; channels = channelCount; encoding = format; count = 0; position = 0; }
        finally { lock.unlock(); }
    }

    /**
     * 音频线程只复制有界采样，竞争时丢帧以避免阻塞音频输出
     * @param input - Media3 分流的只读音频视图
     */
    @Override public void handleBuffer(ByteBuffer input) {
        if (!enabled || !lock.tryLock()) return;
        try {
            if (encoding != C.ENCODING_PCM_16BIT && encoding != C.ENCODING_PCM_FLOAT) return;
            ByteBuffer data = input.duplicate().order(ByteOrder.LITTLE_ENDIAN);
            int bytes = encoding == C.ENCODING_PCM_FLOAT ? 4 : 2;
            int frameBytes = channels * bytes;
            int frames = Math.min(SIZE, data.remaining() / frameBytes);
            data.position(data.limit() - frames * frameBytes);
            for (int i = 0; i < frames; i++) {
                int start = data.position();
                double left = encoding == C.ENCODING_PCM_FLOAT ? data.getFloat() : data.getShort() / 32768.0;
                double right = channels == 1 ? left : encoding == C.ENCODING_PCM_FLOAT ? data.getFloat() : data.getShort() / 32768.0;
                ring[0][position] = left;
                ring[1][position] = right;
                position = (position + 1) % SIZE;
                count = Math.min(SIZE, count + 1);
                data.position(start + frameBytes);
            }
        } finally { lock.unlock(); }
    }

    /**
     * 在界面线程计算左右声道各一百二十八个对数频段
     * @return 归一化至零到一的频谱
     */
    double[][] sample() {
        double[][] output = new double[2][BINS];
        int rate;
        lock.lock();
        try {
            if (!enabled || count < SIZE) return output;
            rate = sampleRate;
            for (int side = 0; side < 2; side++) {
                for (int i = 0; i < SIZE; i++) real[side][i] = ring[side][(position + i) % SIZE] * window[i];
            }
        } finally { lock.unlock(); }
        for (int side = 0; side < 2; side++) {
            Arrays.fill(imaginary, 0);
            transform(real[side], imaginary);
            for (int bin = 0; bin < BINS; bin++) {
                int low = Math.max(1, (int) (20 * Math.pow(1000, bin / (double) BINS) * SIZE / rate));
                int high = Math.min(SIZE / 2, (int) Math.ceil(20 * Math.pow(1000, (bin + 1.0) / BINS) * SIZE / rate));
                double sum = 0;
                for (int i = low; i < high; i++) sum += Math.hypot(real[side][i], imaginary[i]) / SIZE;
                double average = high > low ? sum / (high - low) : 0;
                output[side][bin] = Math.max(0, Math.min(1, (20 * Math.log10(average + 1e-10) + 60) / 60));
            }
        }
        return output;
    }

    /**
     * 原地执行基二 FFT，不在频谱帧之间保留额外采样
     * @param values - 实部
     * @param imag - 虚部
     */
    private static void transform(double[] values, double[] imag) {
        for (int i = 1, j = 0; i < SIZE; i++) {
            int bit = SIZE >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) { double swap = values[i]; values[i] = values[j]; values[j] = swap; }
        }
        for (int length = 2; length <= SIZE; length <<= 1) {
            double cosine = Math.cos(-2 * Math.PI / length);
            double sine = Math.sin(-2 * Math.PI / length);
            for (int start = 0; start < SIZE; start += length) {
                double wr = 1, wi = 0;
                for (int offset = 0; offset < length / 2; offset++) {
                    int first = start + offset, second = first + length / 2;
                    double tr = values[second] * wr - imag[second] * wi;
                    double ti = values[second] * wi + imag[second] * wr;
                    values[second] = values[first] - tr;
                    imag[second] = imag[first] - ti;
                    values[first] += tr;
                    imag[first] += ti;
                    double next = wr * cosine - wi * sine;
                    wi = wr * sine + wi * cosine;
                    wr = next;
                }
            }
        }
    }
}
