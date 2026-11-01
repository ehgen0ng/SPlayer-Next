package top.imsyy.splayer.car;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Binder;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Parcel;
import android.os.RemoteException;
import android.util.Log;
import android.view.KeyEvent;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import com.getcapacitor.JSObject;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.RejectedExecutionException;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONObject;

/** 比亚迪语音协议适配，播放器、队列和音源仍由现有服务持有 */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
final class BydVoice {
    static final String PACKAGE = "com.byd.autovoice";
    static final String PREFIX = "com.byd.action.";
    private static final String LISTENER = "com.bydsdk.autovoice.IBydMediaListener";
    private static final String REGISTER = "com.bydsdk.autovoice.IBydMediaAIDL";
    private static final String CALLBACK = "com.bydsdk.autovoice.IBydMediaCallback";
    private final PlaybackService service;
    private final Player player;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService remote = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(16));
    private boolean bound;
    private boolean closed;
    private IBinder registration;
    private volatile IBinder callback;
    private CompletableFuture<Object> active;
    private boolean searching;
    private String expectedMediaId;
    private String lastState = "";

    private final Binder listener = new Binder() {
        /**
         * 按实车样本事务顺序接收回调和三类指令，Binder 线程不访问播放器
         * @param code - 事务编号
         * @param data - 请求载荷
         * @param reply - 同步响应
         * @param flags - Binder 标志
         * @return 是否识别该事务
         */
        @Override protected boolean onTransact(int code, Parcel data, Parcel reply, int flags) throws RemoteException {
            if (code == INTERFACE_TRANSACTION) { reply.writeString(LISTENER); return true; }
            if (code < 1 || code > 4) return super.onTransact(code, data, reply, flags);
            data.enforceInterface(LISTENER);
            if (code == 1) callback = data.readStrongBinder();
            else {
                String method = data.readString();
                String params = data.readString();
                IBinder response = callback;
                main.post(() -> dispatch(method, params, code == 4, result -> sendBinderResult(response, result)));
            }
            reply.writeNoException();
            return true;
        }
    };

    private final ServiceConnection connection = new ServiceConnection() {
        /**
         * 使用包名、音乐类型和监听 Binder 注册小迪控制入口
         * @param name - 厂商组件
         * @param binder - 厂商注册接口
         */
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            if (closed) return;
            registration = binder;
            postRemote(() -> {
                Parcel data = Parcel.obtain(), reply = Parcel.obtain();
                try {
                    data.writeInterfaceToken(REGISTER);
                    data.writeString(service.getPackageName());
                    data.writeIntArray(new int[] {1001});
                    data.writeStrongBinder(listener);
                    if (!binder.transact(1, data, reply, 0)) throw new RemoteException("不支持注册事务");
                    reply.readException();
                    Log.i("SPlayerByd", "语音监听注册调用完成");
                } catch (Exception error) { Log.w("SPlayerByd", "语音监听注册失败", error); }
                finally { data.recycle(); reply.recycle(); }
            });
        }

        /**
         * 等待 Android 重连现有绑定，不累积额外连接
         * @param name - 断开的厂商组件
         */
        @Override public void onServiceDisconnected(ComponentName name) { registration = null; callback = null; }

        /**
         * 厂商组件更新后释放失效绑定并重新注册
         * @param name - 更新的组件
         */
        @Override public void onBindingDied(ComponentName name) {
            if (closed) return;
            service.unbindService(this);
            bound = false;
            registration = null;
            callback = null;
            register();
        }

        /**
         * 厂商服务未提供 Binder 时释放绑定，下一次注册广播可重新尝试
         * @param name - 未提供接口的组件
         */
        @Override public void onNullBinding(ComponentName name) {
            if (closed) return;
            service.unbindService(this);
            bound = false;
        }
    };

    private final Player.Listener stateListener = new Player.Listener() {
        /**
         * 只广播低频状态变化，并以实际播放事件结束语音等待
         * @param current - 唯一媒体播放器
         * @param events - 本批状态变化
         */
        @Override public void onEvents(Player current, Player.Events events) {
            publishState();
            if (active == null || expectedMediaId == null) return;
            MediaItem item = current.getCurrentMediaItem();
            if (item == null || !expectedMediaId.equals(item.mediaId)) failActive("播放曲目已改变");
            else if (current.isPlaying()) active.complete(null);
            else if (!current.getPlayWhenReady()) failActive("播放已取消");
        }

        /**
         * 语音点播遇到真实播放错误时回报失败
         * @param error - Media3 播放错误
         */
        @Override public void onPlayerError(PlaybackException error) { failActive("音源播放失败"); }
    };

    /**
     * 将协议生命周期绑定到现有媒体服务
     * @param service - 后台媒体服务
     * @param player - 唯一播放器
     */
    BydVoice(PlaybackService service, Player player) {
        this.service = service;
        this.player = player;
        player.addListener(stateListener);
    }

    /** 申请成为默认音乐候选并连接语音服务，不修改用户的默认选择 */
    void register() {
        if (closed) return;
        service.sendBroadcast(new Intent(PREFIX + "FUNCTION_UPDATE").setPackage(PACKAGE)
            .putExtra("EXTRA_PACKAGE_NAME", service.getPackageName())
            .putExtra("EXTRA_APPLICATION_TYPE", "MUSIC").putExtra("ISCONTROL", "TRUE")
            .putExtra("EXTRA_SERVICE_NAME", BydCommandService.class.getName()));
        Log.i("SPlayerByd", "已发送默认音乐候选注册申请");
        if (bound) return;
        try {
            bound = service.bindService(new Intent(PREFIX + "AUTOVOICE_MEDIA_REGISTER").setPackage(PACKAGE),
                connection, Context.BIND_AUTO_CREATE);
            Log.i("SPlayerByd", "语音服务绑定=" + bound);
        } catch (RuntimeException error) { Log.w("SPlayerByd", "无法绑定语音服务", error); }
    }

    /**
     * 将两代广播的参数转换成统一指令，异步结果仍回到原来的协议通道
     * @param intent - 厂商广播或候选服务启动意图
     * @return 指令结果发出后的完成信号
     */
    CompletableFuture<Void> handleIntent(Intent intent) {
        CompletableFuture<Void> finished = new CompletableFuture<>();
        String action = intent.getAction();
        if (action == null || action.equals(PREFIX + "AUTOVOICE_MEDIA_REGISTER")) {
            register();
            finished.complete(null);
            return finished;
        }
        if (action.equals(PREFIX + "FUNCTION_UPDATE_RESULT")) {
            Log.i("SPlayerByd", "收到默认音乐注册回执，字段=" + (intent.getExtras() == null ? "[]" : intent.getExtras().keySet()));
            finished.complete(null);
            return finished;
        }
        boolean common = action.startsWith(PREFIX + "AUTOVOICE_COMMON_");
        Consumer<JSObject> response = result -> {
            if (common) service.sendBroadcast(new Intent(PREFIX + "AUTOVOICE_COMMON_RESULT").setPackage(PACKAGE)
                .putExtra("mediaApp", service.getPackageName()).putExtra("result", result.toString()));
            else service.sendBroadcast(new Intent(PREFIX + "AUTOVOICE_CMD_RESULT").setPackage(PACKAGE)
                .putExtra("EXTRA_RESULT_ACTION", action).putExtra("EXTRA_PACKAGE_NAME", service.getPackageName())
                .putExtra("EXTRA_RESULT_CODE", Integer.toString(result.optInt("code")))
                .putExtra("EXTRA_RESULT_MESSAGE", result.optString("msg", "")));
            finished.complete(null);
        };
        try {
            String method;
            String params = "{}";
            boolean query = false;
            if (common) {
                String kind = action.substring((PREFIX + "AUTOVOICE_COMMON_").length());
                if (!kind.equals("CONTROL") && !kind.equals("OPERATION") && !kind.equals("QUERY")) {
                    finished.complete(null);
                    return finished;
                }
                method = intent.getStringExtra("EXTRA_COMMON_" + kind + "_METHOD");
                params = intent.getStringExtra("EXTRA_COMMON_" + kind + "_PARAM");
                query = kind.equals("QUERY");
            } else if (action.equals(PREFIX + "AUTOVOICE_SEARCH_PLUS")) {
                method = "searchMusic";
                params = new JSObject().put("song", firstKeyword(intent.getStringExtra("EXTRA_KEYWORDS_SEARCH")))
                    .put("artist", firstKeyword(intent.getStringExtra("EXTRA_ARTIST_SEARCH"))).toString();
            } else if (action.equals("byd.intent.action.MEDIA_BUTTON")) {
                KeyEvent key = intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                if (key == null || key.getAction() != KeyEvent.ACTION_DOWN || key.getRepeatCount() > 0) {
                    finished.complete(null);
                    return finished;
                }
                method = switch (key.getKeyCode()) {
                    case KeyEvent.KEYCODE_MEDIA_PLAY -> "play";
                    case KeyEvent.KEYCODE_MEDIA_PAUSE -> "pause";
                    case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> player.getPlayWhenReady() ? "pause" : "play";
                    case KeyEvent.KEYCODE_MEDIA_NEXT -> "next";
                    case KeyEvent.KEYCODE_MEDIA_PREVIOUS -> "previous";
                    default -> "unsupported";
                };
            } else {
                method = switch (action) {
                    case PREFIX + "AUTOVOICE_FORWARD" -> "forward";
                    case PREFIX + "AUTOVOICE_REWIND" -> "rewind";
                    case PREFIX + "AUTOVOICE_JUMP_TO" -> "jumpToPlay";
                    case PREFIX + "AUTOVOICE_PLAY_MODE" -> "setPlayPattern";
                    case PREFIX + "AUTOVOICE_QUIT" -> "pause";
                    default -> "unsupported";
                };
                JSObject values = new JSObject();
                if (intent.hasExtra("EXTRA_SET_TIME")) values.put("time", intent.getStringExtra("EXTRA_SET_TIME"));
                else if (method.equals("forward") || method.equals("rewind")) values.put("time", 10);
                else if (method.equals("jumpToPlay")) {
                    response.accept(result(method, 3, "缺少跳转时间"));
                    return finished;
                }
                if (intent.hasExtra("EXTRA_PLAY_MODE")) values.put("pattern", intent.getStringExtra("EXTRA_PLAY_MODE"));
                params = values.toString();
            }
            dispatch(method, params, query, response);
        } catch (RuntimeException error) { response.accept(result(action, 1, "语音参数无效")); }
        return finished;
    }

    /**
     * 取旧协议候选词的首项，与样本客户端的处理一致
     * @param value - 竖线分隔的识别候选
     * @return 首个候选词
     */
    private static String firstKeyword(String value) { return value == null ? "" : value.split("\\|", 2)[0].trim(); }

    /**
     * 在主线程分发查询和控制，仅在完成后返回成功
     * @param method - 已核实的方法名
     * @param text - 参数 JSON
     * @param query - 是否只读查询
     * @param respond - 本次请求的独立响应通道
     */
    private void dispatch(String method, String text, boolean query, Consumer<JSObject> respond) {
        if (closed) { respond.accept(result(method, 1, "媒体服务已停止")); return; }
        CompletableFuture<Object> request = new CompletableFuture<>();
        try {
            if (method == null || method.trim().isEmpty()) throw new IllegalArgumentException("缺少语音方法");
            if (query) { respond.accept(result(method, 0, query(method))); return; }
            JSONObject params = text == null || text.trim().isEmpty() ? new JSONObject() : new JSONObject(text);
            failActive("已被新的语音指令替代");
            active = request;
            Runnable timeout = () -> request.completeExceptionally(new IllegalStateException("语音执行超时"));
            main.postDelayed(timeout, 60_000);
            request.whenComplete((value, error) -> {
                main.removeCallbacks(timeout);
                if (active == request) { active = null; searching = false; expectedMediaId = null; }
                int code = error == null ? 0 : error instanceof UnsupportedOperationException ? 3
                    : error instanceof java.util.NoSuchElementException ? 7 : 1;
                respond.accept(result(method, code, error == null ? value : error.getMessage()));
            });
            if (method.equals("searchMusic")) {
                String song = params.optString("song", "").trim(), artist = params.optString("artist", "").trim();
                if (song.isEmpty() && artist.isEmpty()) throw new IllegalArgumentException("请提供歌名或歌手");
                searching = true;
                NodeRuntime.invoke("android:voiceSearch", new JSONArray().put(service.voiceSearchPlatform()).put(song).put(artist))
                    .whenComplete((track, error) -> main.post(() -> {
                        if (request != active || request.isDone()) return;
                        searching = false;
                        if (error != null) request.completeExceptionally(error);
                        else if (!(track instanceof JSONObject)) request.completeExceptionally(new java.util.NoSuchElementException("未找到歌曲"));
                        else execute(request, "android:playTrack", new JSONArray().put(track), true);
                    }));
            } else if (method.equals("setPlayPattern")) {
                String pattern = params.getString("pattern");
                if (!pattern.equals("CYCLE") && !pattern.equals("RANDOM") && !pattern.equals("LOOP"))
                    throw new UnsupportedOperationException("不支持该播放模式");
                service.invoke("android:setShuffle", new JSONArray().put(pattern.equals("RANDOM") ? "on" : "off"))
                    .thenCompose(value -> service.invoke("android:setRepeat", new JSONArray().put(pattern.equals("CYCLE") ? "one" : "list")))
                    .whenComplete((value, error) -> { if (error == null) request.complete(null); else request.completeExceptionally(error); });
            } else {
                String channel = switch (method) {
                    case "play" -> "player:play";
                    case "pause" -> "player:pause";
                    case "next" -> "android:next";
                    case "previous" -> "android:prev";
                    case "jumpToPlay", "forward", "rewind" -> "player:seek";
                    default -> throw new UnsupportedOperationException("暂不支持该语音指令");
                };
                JSONArray args = new JSONArray();
                if (!method.equals("pause") && player.getMediaItemCount() == 0) throw new java.util.NoSuchElementException("播放队列为空");
                if (channel.equals("player:seek")) {
                    double seconds = params.has("time") ? params.getDouble("time") : method.equals("jumpToPlay") ? 0 : 30;
                    if (!Double.isFinite(seconds) || seconds < 0) throw new IllegalArgumentException("播放时间无效");
                    double position = seconds * 1000;
                    if (method.equals("forward")) position += player.getCurrentPosition();
                    if (method.equals("rewind")) position = player.getCurrentPosition() - position;
                    long duration = player.getDuration();
                    args.put((long) Math.max(0, duration > 0 ? Math.min(position, duration) : position));
                }
                execute(request, channel, args, method.equals("play") || method.equals("next") || method.equals("previous"));
            }
        } catch (Exception error) {
            if (active == request) request.completeExceptionally(error);
            else respond.accept(result(method, error instanceof UnsupportedOperationException ? 3 : 1, error.getMessage()));
        }
    }

    /**
     * 复用应用控制入口，点播等待当前媒体项真正开始播放
     * @param request - 当前语音请求
     * @param channel - 既有原生控制方法
     * @param args - 控制参数
     * @param waitForPlayback - 是否等待音频实际输出
     */
    private void execute(CompletableFuture<Object> request, String channel, JSONArray args, boolean waitForPlayback) {
        service.invoke(channel, args).whenComplete((value, error) -> {
            if (request != active || request.isDone()) return;
            if (error != null) request.completeExceptionally(error);
            else if (!waitForPlayback || player.isPlaying()) request.complete(null);
            else {
                MediaItem current = player.getCurrentMediaItem();
                if (current == null || !player.getPlayWhenReady()) request.completeExceptionally(new IllegalStateException("播放未开始"));
                else expectedMediaId = current.mediaId;
            }
        });
    }

    /**
     * 用户在搜索期间操作播放时废弃迟到的点歌结果
     * @param channel - 现有播放控制通道
     */
    void onPlaybackCommand(String channel) {
        if (!searching) return;
        switch (channel) {
            case "player:play", "player:pause", "player:stop", "player:seek", "android:next", "android:prev",
                "android:playTrack", "android:playAt", "android:replaceQueue", "android:clearQueue", "android:startFm":
                failActive("播放操作已取消此前点歌");
        }
    }

    /**
     * 从播放器直接读取低成本查询结果，不依赖后台界面定时器
     * @param method - 查询方法
     * @return 厂商协议定义的消息内容
     */
    private Object query(String method) {
        String pattern = player.getShuffleModeEnabled() ? "RANDOM" : player.getRepeatMode() == Player.REPEAT_MODE_ONE ? "CYCLE" : "LOOP";
        return switch (method) {
            case "getPlayStatus" -> new JSObject().put("playStatus", player.isPlaying() ? 1 : 2);
            case "getPlayState" -> new JSObject().put("playStatus", player.isPlaying() ? 1 : 2).put("mediaType", 1001).put("mediaSource", 12);
            case "getPlayTime" -> new JSObject().put("time", player.getCurrentPosition() / 1000);
            case "getPlayContent" -> new JSObject().put("name", String.valueOf(player.getMediaMetadata().title == null ? "" : player.getMediaMetadata().title))
                .put("artist", String.valueOf(player.getMediaMetadata().artist == null ? "" : player.getMediaMetadata().artist))
                .put("album", String.valueOf(player.getMediaMetadata().albumTitle == null ? "" : player.getMediaMetadata().albumTitle));
            case "getSupportMediaTypes" -> new JSONArray().put(1001);
            case "getSupportMediaSource" -> new JSONArray().put(12);
            case "getSupportPatterns" -> new JSONArray().put("CYCLE").put("RANDOM").put("LOOP");
            case "getCurPattern" -> pattern;
            default -> throw new UnsupportedOperationException("暂不支持该查询");
        };
    }

    /** 仅在曲名、歌手或播放状态变化时通知旧版小迪，不推送高频进度 */
    private void publishState() {
        String state = player.isPlaying() ? "STATE_PLAY" : player.getPlaybackState() == Player.STATE_ENDED
            || player.getMediaItemCount() == 0 ? "STATE_FINISH" : "STATE_PAUSE";
        String title = player.getMediaMetadata().title == null ? "" : player.getMediaMetadata().title.toString();
        String artist = player.getMediaMetadata().artist == null ? "" : player.getMediaMetadata().artist.toString();
        String next = new JSONArray().put(state).put(title).put(artist).toString();
        if (next.equals(lastState)) return;
        lastState = next;
        service.sendBroadcast(new Intent(PREFIX + "NOTIFY_AUTOVOICE_CURRENT_STATE").setPackage(PACKAGE)
            .putExtra("EXTRA_PLAY_STATE", state).putExtra("EXTRA_PROGRAM_NAME", title).putExtra("EXTRA_ARTIST_NAME", artist));
    }

    /**
     * 构造两代协议共用的执行结果
     * @param method - 原方法名
     * @param code - 协议状态码
     * @param message - 查询数据或失败原因
     * @return 结果 JSON
     */
    private static JSObject result(String method, int code, Object message) {
        JSObject result = new JSObject().put("action", method == null ? "" : method).put("code", code);
        if (message != null) result.put("msg", message);
        Log.i("SPlayerByd", "语音结果 method=" + method + " code=" + code);
        return result;
    }

    /**
     * 在专用线程发送同步 Binder 回包，避免厂商进程阻塞播放器主线程
     * @param target - 本次请求捕获的回调接口
     * @param result - 已完成的执行结果
     */
    private void sendBinderResult(IBinder target, JSObject result) {
        if (target == null || remote.isShutdown()) return;
        postRemote(() -> {
            Parcel data = Parcel.obtain(), reply = Parcel.obtain();
            try {
                data.writeInterfaceToken(CALLBACK);
                data.writeString(service.getPackageName());
                data.writeString(result.toString());
                if (!target.transact(1, data, reply, 0)) throw new RemoteException("不支持结果事务");
                reply.readException();
            } catch (Exception error) { Log.w("SPlayerByd", "语音结果回传失败", error); }
            finally { data.recycle(); reply.recycle(); }
        });
    }

    /**
     * 取消唯一在途指令，释放它的定时器和结果接收器
     * @param reason - 取消原因
     */
    private void failActive(String reason) {
        if (active != null) active.completeExceptionally(new IllegalStateException(reason));
    }

    /**
     * 限制厂商 Binder 在途调用，远端无响应时不无限保留回包
     * @param operation - 注册、结果回传或解除注册调用
     */
    private void postRemote(Runnable operation) {
        try { remote.execute(operation); }
        catch (RejectedExecutionException error) { Log.w("SPlayerByd", "语音回调队列不可用"); }
    }

    /** 解除厂商绑定和状态监听，服务销毁后不保留播放对象 */
    void close() {
        closed = true;
        failActive("媒体服务已停止");
        player.removeListener(stateListener);
        IBinder target = registration;
        if (target != null) postRemote(() -> {
            Parcel data = Parcel.obtain(), reply = Parcel.obtain();
            try {
                data.writeInterfaceToken(REGISTER);
                data.writeString(service.getPackageName());
                if (target.transact(4, data, reply, 0)) reply.readException();
            } catch (Exception error) { Log.w("SPlayerByd", "解除语音监听失败", error); }
            finally { data.recycle(); reply.recycle(); }
        });
        if (bound) service.unbindService(connection);
        callback = null;
        registration = null;
        remote.shutdown();
        main.removeCallbacksAndMessages(null);
    }
}
