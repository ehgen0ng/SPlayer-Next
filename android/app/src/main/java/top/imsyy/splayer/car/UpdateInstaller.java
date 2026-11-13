package top.imsyy.splayer.car;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Base64;
import com.getcapacitor.JSObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import org.json.JSONArray;

/** APK 更新只能使用本应用私有缓存，系统安装前校验发布身份 */
final class UpdateInstaller {
    /**
     * 返回实际安装版本与唯一的更新缓存位置
     * @param context - 应用上下文
     * @return 当前版本编号、支持架构和私有 APK 路径
     */
    static JSObject info(Context context) throws Exception {
        PackageInfo installed = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        return new JSObject().put("versionCode", versionCode(installed))
            .put("abis", new JSONArray(Arrays.asList(Build.SUPPORTED_ABIS)))
            .put("apkPath", new File(context.getCacheDir(), "updates/update.apk").getCanonicalPath());
    }

    /**
     * 校验 APK 未被替换，并且由当前应用相同的签名密钥发布
     * @param context - 应用上下文
     * @param path - 已下载的私有 APK 路径
     * @param version - 检查结果中的版本名称
     * @param expectedHash - 从原仓库取得的 SHA-512 摘要
     * @return 可以交给系统安装器的 APK
     */
    @SuppressWarnings("deprecation")
    static File verify(Context context, String path, String version, String expectedHash) throws Exception {
        File apk = new File(context.getCacheDir(), "updates/update.apk").getCanonicalFile();
        if (!apk.getPath().equals(path) || !apk.isFile()) throw new IOException("更新 APK 路径无效");
        MessageDigest hash = MessageDigest.getInstance("SHA-512");
        try (FileInputStream input = new FileInputStream(apk)) {
            byte[] buffer = new byte[65536];
            int count;
            while ((count = input.read(buffer)) != -1) hash.update(buffer, 0, count);
        }
        if (!Base64.encodeToString(hash.digest(), Base64.NO_WRAP).equals(expectedHash)) {
            throw new IOException("更新 APK 的 SHA-512 摘要不一致");
        }
        PackageManager packages = context.getPackageManager();
        PackageInfo next = packages.getPackageArchiveInfo(apk.getPath(), PackageManager.GET_SIGNATURES);
        PackageInfo installed = packages.getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNATURES);
        if (next == null || !context.getPackageName().equals(next.packageName)
            || !version.equals(next.versionName) || versionCode(next) <= versionCode(installed)) {
            throw new IOException("更新 APK 的包名或版本无效");
        }
        if (next.signatures == null || installed.signatures == null || next.signatures.length == 0
            || !new HashSet<>(Arrays.asList(next.signatures)).equals(new HashSet<>(Arrays.asList(installed.signatures)))) {
            throw new IOException("更新 APK 的签名与当前安装版本不一致");
        }
        return apk;
    }

    /**
     * 兼容最低支持系统的版本编号读取
     * @param info - APK 或当前安装包信息
     * @return 递增的 Android 版本编号
     */
    @SuppressWarnings("deprecation")
    private static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }
}
