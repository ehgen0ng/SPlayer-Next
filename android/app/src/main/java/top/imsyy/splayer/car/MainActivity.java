package top.imsyy.splayer.car;

import com.getcapacitor.BridgeActivity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Build;
import android.net.Uri;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;

public class MainActivity extends BridgeActivity {
    private CompletableFuture<Object> pluginSelection;
    private CompletableFuture<Object> updateInstallation;
    private File updateApk;

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
     * 后台校验 APK，再由系统请求来源授权并安装
     * @param path - 私有更新包路径
     * @param version - 目标版本名称
     * @param sha512 - 原仓库发布摘要
     * @return 用户取消时返回 false，成功安装会由系统终止旧进程
     */
    CompletableFuture<Object> installUpdate(String path, String version, String sha512) {
        if (updateInstallation != null) throw new IllegalStateException("已有更新安装窗口");
        CompletableFuture<Object> pending = new CompletableFuture<>();
        updateInstallation = pending;
        CompletableFuture.supplyAsync(() -> {
            try { return UpdateInstaller.verify(this, path, version, sha512); }
            catch (Exception error) { throw new java.util.concurrent.CompletionException(error); }
        }).whenComplete((apk, error) -> runOnUiThread(() -> {
            if (updateInstallation != pending) return;
            if (error != null) { finishUpdate(false, error); return; }
            updateApk = apk;
            try {
                if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
                    startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName())), 7312);
                } else launchUpdateInstaller();
            } catch (Exception failure) { finishUpdate(false, failure); }
        }));
        return pending;
    }

    /** 将已校验的 APK 以只读内容 URI 交给系统安装器 */
    @SuppressWarnings("deprecation")
    private void launchUpdateInstaller() {
        Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", updateApk);
        Intent intent = new Intent(Intent.ACTION_INSTALL_PACKAGE, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            .putExtra(Intent.EXTRA_RETURN_RESULT, true);
        startActivityForResult(intent, 7313);
    }

    /**
     * 释放安装等待，取消时允许重试同一个更新包
     * @param installed - 系统是否报告安装成功
     * @param error - 安装或授权错误
     */
    private void finishUpdate(boolean installed, Throwable error) {
        CompletableFuture<Object> pending = updateInstallation;
        updateInstallation = null;
        updateApk = null;
        if (pending == null) return;
        if (error != null) pending.completeExceptionally(error);
        else pending.complete(installed);
    }

    /**
     * 处理更新来源授权、系统安装和插件文件选择结果
     * @param request - 请求编号
     * @param result - 选择结果
     * @param data - 文档地址
     */
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 7312 && updateInstallation != null) {
            try {
                if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) finishUpdate(false, null);
                else launchUpdateInstaller();
            } catch (Exception error) { finishUpdate(false, error); }
            return;
        }
        if (request == 7313) { finishUpdate(result == RESULT_OK, null); return; }
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
        finishUpdate(false, null);
        if (pluginSelection != null) pluginSelection.complete(null);
        if (NativePlatform.activity.get() == this) NativePlatform.activity.clear();
        super.onDestroy();
    }
}
