#include <jni.h>
#include <node.h>
#include <uv.h>
#include <v8.h>
#include <atomic>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace {
JavaVM* java_vm = nullptr;
jclass runtime_class = nullptr;
jmethodID receive_method = nullptr;
uv_async_t incoming;
std::mutex queue_mutex;
std::deque<std::u16string> messages;
std::atomic<bool> started{false};
std::atomic<bool> listening{false};
v8::Isolate* node_isolate = nullptr;
v8::Global<v8::Function> receiver;
std::unique_ptr<node::AsyncResource> resource;

/**
 * 在 Node 线程向 Java 投递 JSON，保留 UTF-16 中的中文与代理对
 * @param args - 唯一参数为消息字符串
 */
void PostMessage(const v8::FunctionCallbackInfo<v8::Value>& args) {
  if (args.Length() != 1 || !args[0]->IsString()) return;
  JNIEnv* env = nullptr;
  const bool attach = java_vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK;
  if (attach && java_vm->AttachCurrentThread(&env, nullptr) != JNI_OK) return;
  v8::String::Value text(args.GetIsolate(), args[0]);
  jstring message = env->NewString(reinterpret_cast<const jchar*>(*text), text.length());
  env->CallStaticVoidMethod(runtime_class, receive_method, message);
  env->DeleteLocalRef(message);
  if (env->ExceptionCheck()) env->ExceptionClear();
  if (attach) java_vm->DetachCurrentThread();
}

/**
 * 在 Node 事件循环中消费 Java 发来的消息
 * @param handle - 唤醒消息循环的异步句柄
 */
void DrainMessages(uv_async_t* handle) {
  std::deque<std::u16string> batch;
  {
    std::lock_guard<std::mutex> guard(queue_mutex);
    batch.swap(messages);
  }
  v8::HandleScope scope(node_isolate);
  const auto callback = receiver.Get(node_isolate);
  for (const auto& message : batch) {
    v8::Local<v8::Value> value = v8::String::NewFromTwoByte(
        node_isolate, reinterpret_cast<const uint16_t*>(message.data()),
        v8::NewStringType::kNormal, static_cast<int>(message.size())).ToLocalChecked();
    resource->MakeCallback(callback, 1, &value);
  }
}

/**
 * 注册唯一的 Node 消息接收器
 * @param args - 唯一参数为接收消息的函数
 */
void SetReceiver(const v8::FunctionCallbackInfo<v8::Value>& args) {
  if (args.Length() != 1 || !args[0]->IsFunction()) return;
  receiver.Reset(args.GetIsolate(), args[0].As<v8::Function>());
  listening.store(true);
}

/**
 * 清理 Node 环境持有的回调与消息
 * @param data - 环境清理参数
 */
void Cleanup(void* data) {
  listening.store(false);
  receiver.Reset();
  resource.reset();
  uv_close(reinterpret_cast<uv_handle_t*>(&incoming), nullptr);
  std::lock_guard<std::mutex> guard(queue_mutex);
  messages.clear();
}

/**
 * 注册仅供应用入口使用的链接模块
 * @param exports - 暴露给 Node 的方法
 * @param module - 当前模块对象
 * @param context - Node 执行上下文
 * @param data - 模块私有参数
 */
void Initialize(v8::Local<v8::Object> exports, v8::Local<v8::Value> module,
                v8::Local<v8::Context> context, void* data) {
  node_isolate = context->GetIsolate();
  uv_async_init(node::GetCurrentEventLoop(node_isolate), &incoming, DrainMessages);
  resource = std::make_unique<node::AsyncResource>(node_isolate, exports, "SPlayerBridge");
  NODE_SET_METHOD(exports, "postMessage", PostMessage);
  NODE_SET_METHOD(exports, "onMessage", SetReceiver);
  node::AddEnvironmentCleanupHook(node_isolate, Cleanup, nullptr);
}
NODE_MODULE_LINKED(splayer, Initialize)
}

/**
 * 在 Java 创建的专用线程内启动一次 Node 引擎
 * @param env - JNI 环境
 * @param clazz - Java 运行时类
 * @param arguments - 入口、私有目录、原生库目录与版本
 * @returns Node 退出码，重复启动时返回 -1
 */
extern "C" JNIEXPORT jint JNICALL
Java_top_imsyy_splayer_car_NodeRuntime_startNode(JNIEnv* env, jclass clazz, jobjectArray arguments) {
  if (started.exchange(true)) return -1;
  env->GetJavaVM(&java_vm);
  runtime_class = reinterpret_cast<jclass>(env->NewGlobalRef(clazz));
  receive_method = env->GetStaticMethodID(clazz, "onNodeMessage", "(Ljava/lang/String;)V");
  const int count = env->GetArrayLength(arguments);
  std::vector<std::string> strings;
  strings.reserve(count);
  for (int index = 0; index < count; ++index) {
    auto value = static_cast<jstring>(env->GetObjectArrayElement(arguments, index));
    const char* text = env->GetStringUTFChars(value, nullptr);
    strings.emplace_back(text);
    env->ReleaseStringUTFChars(value, text);
    env->DeleteLocalRef(value);
  }
  std::vector<char*> argv;
  for (auto& value : strings) argv.push_back(value.data());
  const int result = node::Start(count, argv.data());
  env->DeleteGlobalRef(runtime_class);
  runtime_class = nullptr;
  return result;
}

/**
 * 将 Java 消息放入有界队列并唤醒 Node 事件循环
 * @param env - JNI 环境
 * @param clazz - Java 运行时类
 * @param message - 序列化的请求或响应
 * @returns 运行时未就绪或队列已满时返回 false
 */
extern "C" JNIEXPORT jboolean JNICALL
Java_top_imsyy_splayer_car_NodeRuntime_sendToNode(JNIEnv* env, jclass clazz, jstring message) {
  if (!listening.load()) return false;
  const auto length = env->GetStringLength(message);
  if (length > 4 * 1024 * 1024) return false;
  std::lock_guard<std::mutex> guard(queue_mutex);
  if (messages.size() >= 64) return false;
  const jchar* text = env->GetStringChars(message, nullptr);
  messages.emplace_back(reinterpret_cast<const char16_t*>(text), length);
  env->ReleaseStringChars(message, text);
  uv_async_send(&incoming);
  return true;
}
