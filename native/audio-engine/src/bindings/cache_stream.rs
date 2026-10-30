use super::IntoNapiResult;
use crate::decoder::cache_stream;
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// 注册可增长缓存文件，返回可供预载和播放共用的音源标识
/// @param id - 本次下载的唯一标识
/// @param partialPath - 正在写入的临时文件
/// @param finalPath - 下载完成后的文件
/// @param upstream - 未缓存位置的补充读取地址
/// @param total - 完整文件字节数
#[napi]
pub fn register_cache_stream(
    id: String,
    partial_path: String,
    final_path: String,
    upstream: String,
    total: f64,
) -> Result<String> {
    if !total.is_finite() || total <= 0.0 || total.fract() != 0.0 || total > 9_007_199_254_740_991.0
    {
        return Err(Error::from_reason("缓存文件长度无效"));
    }
    cache_stream::register(id, partial_path, final_path, upstream, total as u64).into_napi()
}

/// 更新已经写入磁盘的缓存字节数并通知下载终态
/// @param source - 注册返回的音源标识
/// @param available - 已落盘字节数
/// @param complete - 是否已完成并重命名
/// @param failed - 下载是否失败或取消
#[napi]
pub fn update_cache_stream(source: String, available: f64, complete: bool, failed: bool) {
    cache_stream::update(&source, available.max(0.0) as u64, complete, failed);
}

/// 释放缓存音源入口，现有读取器会在播放结束后自行释放文件句柄
/// @param source - 注册返回的音源标识
#[napi]
pub fn release_cache_stream(source: String) {
    cache_stream::release(&source);
}
