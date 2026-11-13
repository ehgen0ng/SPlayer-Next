#!/bin/sh
# 等待旧进程释放资源后替换同目录应用，失败时恢复旧版本
set -eu
pid="$1"
target="$2"
work="$3"
staged="$work/$4"
backup="$work/previous.app"

cleanup() {
  if [ -e "$backup" ]; then
    if [ ! -e "$target" ]; then
      /bin/mv "$backup" "$target" || return
    else
      # 回滚失败时保留备份，供下次启动后恢复
      return
    fi
  fi
  /bin/rm -rf "$work"
}
trap cleanup EXIT

attempt=0
while /bin/kill -0 "$pid" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 300 ]; then
    echo "旧应用未退出，取消更新"
    exit 1
  fi
  /bin/sleep 0.2
done

/bin/mv "$target" "$backup"
if ! /bin/mv "$staged" "$target"; then
  /bin/mv "$backup" "$target"
  /usr/bin/open -n "$target"
  exit 1
fi

if /usr/bin/open -n "$target"; then
  /bin/rm -rf "$backup"
else
  /bin/mv "$target" "$staged"
  /bin/mv "$backup" "$target"
  /usr/bin/open -n "$target"
  exit 1
fi
