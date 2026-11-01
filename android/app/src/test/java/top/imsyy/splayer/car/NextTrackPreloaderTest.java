package top.imsyy.splayer.car;

import static org.junit.Assert.assertEquals;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public final class NextTrackPreloaderTest {
    /** 连续超过五首不可用时仍继续寻找后续可播放歌曲 */
    @Test public void continuesBeyondFixedFailureCounts() {
        List<Integer> visited = new ArrayList<>();
        int result = NextTrackPreloader.nextIndex(0, 30, index -> (index + 1) % 30, index -> {
            visited.add(index);
            return index < 22;
        });
        assertEquals(22, result);
        assertEquals(22, visited.size());
    }

    /** 循环队列全部不可用时只遍历一轮，不再次请求起始曲目 */
    @Test public void exhaustedLoopStopsAfterOnePass() {
        List<Integer> visited = new ArrayList<>();
        int result = NextTrackPreloader.nextIndex(0, 12, index -> (index + 1) % 12, index -> {
            visited.add(index);
            return true;
        });
        assertEquals(-1, result);
        assertEquals(11, visited.size());
        assertEquals(11, visited.stream().distinct().count());
    }

    /** 随机模式严格按原生后继顺序查找，不使用列表索引加一 */
    @Test public void followsShuffleOrder() {
        int[] next = {3, 0, 1, 4, 2};
        List<Integer> visited = new ArrayList<>();
        int result = NextTrackPreloader.nextIndex(0, next.length, index -> next[index], index -> {
            visited.add(index);
            return index == 3 || index == 4;
        });
        assertEquals(2, result);
        assertEquals(List.of(3, 4, 2), visited);
    }

    /** 顺序播放达到队尾后停止，不回到已经播放过的歌曲 */
    @Test public void stopsAtNonRepeatingQueueEnd() {
        assertEquals(-1, NextTrackPreloader.nextIndex(1, 4,
            index -> index == 3 ? -1 : index + 1, index -> true));
    }

    /** 只有当前歌曲时不为循环播放反复找源 */
    @Test public void doesNotPreloadCurrentItemAgain() {
        assertEquals(-1, NextTrackPreloader.nextIndex(0, 1, index -> 0, index -> false));
        assertEquals(-1, NextTrackPreloader.nextIndex(0, 0, index -> -1, index -> false));
    }

    /** 已失败项切入前台时，顺延不会把本轮原曲再次选为兜底 */
    @Test public void exhaustedCandidatesDoNotReturnToAnchor() {
        assertEquals(-1, NextTrackPreloader.nextIndex(1, 4,
            index -> (index + 1) % 4, index -> true));
    }
}
