package top.imsyy.splayer.car;

import static org.junit.Assert.*;
import androidx.media3.common.C;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import org.junit.Test;

public class SpectrumSinkTest {
    /** 验证真实 PCM 频率映射、声道隔离及关闭后不保留旧帧 */
    @Test public void separatesStereoToneAndStopsWhenHidden() {
        SpectrumSink sink = new SpectrumSink();
        sink.flush(48000, 2, C.ENCODING_PCM_16BIT);
        sink.setEnabled(true);
        ByteBuffer pcm = ByteBuffer.allocate(2048 * 4).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < 2048; i++) {
            pcm.putShort((short) (16000 * Math.sin(2 * Math.PI * 1000 * i / 48000)));
            pcm.putShort((short) 0);
        }
        pcm.flip();
        sink.handleBuffer(pcm);
        assertEquals(0, pcm.position());
        double[][] values = sink.sample();
        int peak = 0;
        for (int i = 0; i < 128; i++) {
            if (values[0][i] > values[0][peak]) peak = i;
            assertEquals(0, values[1][i], 0.0001);
        }
        assertTrue(peak >= 70 && peak <= 74);
        assertTrue(values[0][peak] > 0.5);
        sink.setEnabled(false);
        sink.handleBuffer(pcm);
        sink.setEnabled(true);
        for (double value : sink.sample()[0]) assertEquals(0, value, 0.0001);
    }
}
