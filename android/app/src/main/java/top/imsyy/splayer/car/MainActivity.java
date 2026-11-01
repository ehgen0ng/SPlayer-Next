package top.imsyy.splayer.car;

import com.getcapacitor.BridgeActivity;
import android.content.Intent;
import android.os.Bundle;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;

public class MainActivity extends BridgeActivity {
    private CompletableFuture<Object> pluginSelection;

    /**
     * 注册唯一的应用桥接，继续使用现有 Vue 入口
     * @param state - Activity 恢复状态
     */
    @Override public void onCreate(Bundle state) {
        registerPlugin(AppBridgePlugin.class);
        super.onCreate(state);
        NativePlatform.activity = new java.lang.ref.WeakReference<>(this);
    }

    /**
     * 通过系统文档选择器导入插件，不请求公共存储权限
     * @return 插件源码，取消时为空
     */
    CompletableFuture<Object> pickPlugin() {
        if (pluginSelection != null) throw new IllegalStateException("已有插件选择窗口");
        pluginSelection = new CompletableFuture<>();
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
        startActivityForResult(intent, 7311);
        return pluginSelection;
    }

    /**
     * 有界读取用户选择的脚本，后续校验由现有插件加载器负责
     * @param request - 请求编号
     * @param result - 选择结果
     * @param data - 文档地址
     */
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != 7311 || pluginSelection == null) return;
        CompletableFuture<Object> pending = pluginSelection;
        pluginSelection = null;
        if (result != RESULT_OK || data == null || data.getData() == null) { pending.complete(null); return; }
        CompletableFuture.runAsync(() -> {
            try (InputStream input = getContentResolver().openInputStream(data.getData()); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (output.size() + count > 5 * 1024 * 1024) throw new IllegalArgumentException("插件文件超过 5 MiB");
                    output.write(buffer, 0, count);
                }
                pending.complete(output.toString(StandardCharsets.UTF_8.name()));
            } catch (Exception error) { pending.completeExceptionally(error); }
        });
    }

    /** 界面销毁时终止文件选择等待，不中断媒体服务 */
    @Override public void onDestroy() {
        if (pluginSelection != null) pluginSelection.complete(null);
        if (NativePlatform.activity.get() == this) NativePlatform.activity.clear();
        super.onDestroy();
    }
}
