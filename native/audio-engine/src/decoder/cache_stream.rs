use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{ensure, Result};
use ffmpeg_audio::{HttpAudioSource, HttpCancelHandle};
use parking_lot::{Condvar, Mutex};

pub(crate) const PREFIX: &str = "cache-stream://";

#[derive(Default)]
struct Progress {
    available: u64,
    complete: bool,
    failed: bool,
}

struct CacheFile {
    partial: PathBuf,
    final_path: PathBuf,
    upstream: String,
    total: u64,
    progress: Mutex<Progress>,
    changed: Condvar,
}

/// 注册表由主进程的下载、预载与当前播放租约持有，租约结束时显式释放
static SOURCES: OnceLock<Mutex<HashMap<String, Arc<CacheFile>>>> = OnceLock::new();

/// 注册已开始落盘的缓存，后续读取实例共享进度但各自持有文件游标
pub(crate) fn register(
    id: String,
    partial: String,
    final_path: String,
    upstream: String,
    total: u64,
) -> Result<String> {
    ensure!(total > 0, "缓存总长度必须大于零");
    let source = format!("{PREFIX}{id}");
    SOURCES.get_or_init(Default::default).lock().insert(
        source.clone(),
        Arc::new(CacheFile {
            partial: partial.into(),
            final_path: final_path.into(),
            upstream,
            total,
            progress: Mutex::default(),
            changed: Condvar::new(),
        }),
    );
    Ok(source)
}

/// 发布已落盘字节数和下载终态，唤醒等待读取的解码器
pub(crate) fn update(source: &str, available: u64, complete: bool, failed: bool) {
    let Some(sources) = SOURCES.get() else { return };
    let Some(file) = sources.lock().get(source).cloned() else {
        return;
    };
    let mut progress = file.progress.lock();
    progress.available = available.min(file.total);
    progress.complete = complete;
    progress.failed = failed || (complete && available != file.total);
    file.changed.notify_all();
}

/// 释放打开入口，已经打开的读取器仍持有共享文件状态
pub(crate) fn release(source: &str) {
    if let Some(sources) = SOURCES.get() {
        sources.lock().remove(source);
    }
}

/// 预载和正式播放共用的可增长缓存读取视图
pub(crate) struct CacheStream {
    shared: Arc<CacheFile>,
    file: File,
    position: u64,
    cancel: HttpCancelHandle,
    remote: Option<HttpAudioSource>,
    seek_gap: bool,
}

impl CacheStream {
    /// 打开已注册缓存；完成时的重命名不改变现有文件句柄
    pub(crate) fn open(source: &str, cancel: HttpCancelHandle) -> Result<Self> {
        let shared = SOURCES
            .get_or_init(Default::default)
            .lock()
            .get(source)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("缓存读取入口已释放"))?;
        // 下载完成的重命名可能与打开文件同时发生
        let file = File::open(&shared.partial).or_else(|_| File::open(&shared.final_path))?;
        Ok(Self {
            shared,
            file,
            position: 0,
            cancel,
            remote: None,
            seek_gap: false,
        })
    }
}

impl Read for CacheStream {
    /// 优先读已落盘区间，追上下载进度时等待，不把暂时的文件末尾当作 EOF
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() || self.position >= self.shared.total {
            return Ok(0);
        }
        loop {
            // read_exact 会自动重试 Interrupted，取消必须作为终止错误返回
            if self.cancel.is_cancelled() {
                return Err(io::Error::new(io::ErrorKind::Other, "缓存读取已取消"));
            }
            let mut progress = self.shared.progress.lock();
            if self.position < progress.available {
                let count = (progress.available - self.position).min(buf.len() as u64) as usize;
                drop(progress);
                self.remote = None;
                self.seek_gap = false;
                self.file.seek(SeekFrom::Start(self.position))?;
                let read = self.file.read(&mut buf[..count])?;
                if read == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "缓存已写入区间不可读",
                    ));
                }
                self.position += read as u64;
                return Ok(read);
            }
            if progress.failed || progress.complete {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "缓存下载未完整完成",
                ));
            }
            if self.seek_gap {
                drop(progress);
                // 容器探测或用户跳转可能先读文件尾，只为缺失区间请求 Range
                if self.remote.is_none() {
                    let mut remote = HttpAudioSource::new_with_cancel_handle(
                        &self.shared.upstream,
                        self.cancel.clone(),
                    )
                    .map_err(|error| io::Error::other(error.to_string()))?;
                    remote.seek(SeekFrom::Start(self.position))?;
                    self.remote = Some(remote);
                }
                let read = self.remote.as_mut().unwrap().read(buf)?;
                self.position += read as u64;
                return Ok(read);
            }
            // 短等待同时响应原生 stop/seek 的取消令牌
            self.shared
                .changed
                .wait_for(&mut progress, Duration::from_millis(20));
        }
    }
}

impl Seek for CacheStream {
    /// 以最终文件长度处理定位，允许跳到尚未落盘的区间
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let target = match position {
            SeekFrom::Start(value) => Some(value),
            SeekFrom::Current(value) => self.position.checked_add_signed(value),
            SeekFrom::End(value) => self.shared.total.checked_add_signed(value),
        }
        .filter(|target| *target <= self.shared.total)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "缓存定位超出文件范围"))?;
        if target == self.position {
            return Ok(target);
        }
        self.position = target;
        self.remote = None;
        self.seek_gap = target > self.shared.progress.lock().available;
        Ok(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;

    static IDS: AtomicU64 = AtomicU64::new(0);

    /// 建立仅写入一半数据的独立测试缓存
    fn fixture() -> (String, PathBuf, PathBuf) {
        let id = format!(
            "{}-{}",
            std::process::id(),
            IDS.fetch_add(1, Ordering::Relaxed)
        );
        let partial = std::env::temp_dir().join(format!("splayer-growing-{id}.part"));
        let final_path = partial.with_extension("bin");
        std::fs::write(&partial, b"abcd").unwrap();
        let source = register(
            id,
            partial.to_str().unwrap().into(),
            final_path.to_str().unwrap().into(),
            "http://127.0.0.1:1/unused".into(),
            8,
        )
        .unwrap();
        update(&source, 4, false, false);
        (source, partial, final_path)
    }

    #[test]
    fn waits_for_written_bytes_and_survives_rename() {
        let (source, partial, final_path) = fixture();
        let mut reader = CacheStream::open(&source, HttpCancelHandle::new()).unwrap();
        assert_eq!(reader.seek(SeekFrom::End(0)).unwrap(), 8);
        reader.seek(SeekFrom::Start(0)).unwrap();
        let mut prefix = [0; 4];
        reader.read_exact(&mut prefix).unwrap();
        assert_eq!(&prefix, b"abcd");
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut rest = Vec::new();
            reader.read_to_end(&mut rest).unwrap();
            tx.send(rest).unwrap();
        });
        assert!(rx.recv_timeout(Duration::from_millis(60)).is_err());
        let mut writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&partial)
            .unwrap();
        writer.write_all(b"efgh").unwrap();
        drop(writer);
        std::fs::rename(&partial, &final_path).unwrap();
        update(&source, 8, true, false);
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), b"efgh");
        worker.join().unwrap();
        let mut reopened = CacheStream::open(&source, HttpCancelHandle::new()).unwrap();
        release(&source);
        let mut all = Vec::new();
        reopened.read_to_end(&mut all).unwrap();
        assert_eq!(all, b"abcdefgh");
        std::fs::remove_file(final_path).unwrap();
    }

    #[test]
    fn cancellation_wakes_waiting_reader() {
        let (source, partial, _) = fixture();
        let cancel = HttpCancelHandle::new();
        let mut reader = CacheStream::open(&source, cancel.clone()).unwrap();
        reader.seek(SeekFrom::Start(4)).unwrap();
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            tx.send(reader.read(&mut [0; 1]).unwrap_err().kind())
                .unwrap()
        });
        assert!(rx.recv_timeout(Duration::from_millis(60)).is_err());
        cancel.cancel();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            io::ErrorKind::Other
        );
        worker.join().unwrap();
        release(&source);
        std::fs::remove_file(partial).unwrap();
    }

    #[test]
    fn failed_download_is_not_a_successful_eof() {
        let (source, partial, _) = fixture();
        let mut reader = CacheStream::open(&source, HttpCancelHandle::new()).unwrap();
        reader.seek(SeekFrom::Start(4)).unwrap();
        update(&source, 4, false, true);
        assert_eq!(
            reader.read(&mut [0; 1]).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        release(&source);
        std::fs::remove_file(partial).unwrap();
    }
}
