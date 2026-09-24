#!/bin/sh
# 把本机已安装的全部 Agent 实例切换到新的面板地址，并改为 HTTP 上报；Token 和其他配置不变。
#
#   wget -qO- https://raw.githubusercontent.com/sbaliyun/esa-vps-monitor/main/agent/switch-server.sh | sh -s -- https://status.example.com
#
# 支持 root 安装的 systemd / OpenRC 实例，以及当前用户的用户模式（nohup）实例。
# 加 --dry-run 只显示将要修改的文件。
set -eu

NEW_SERVER=""
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,8p' "$0" 2>/dev/null || true; exit 0 ;;
    *) NEW_SERVER="$arg" ;;
  esac
done

case "$NEW_SERVER" in
  https://*|http://*) ;;
  *) echo "用法：sh switch-server.sh https://新域名 [--dry-run]" >&2; exit 2 ;;
esac
NEW_SERVER="${NEW_SERVER%/}"
case "$NEW_SERVER" in
  *[!A-Za-z0-9.:/_-]*) echo "地址只能包含字母、数字和 . : / _ -：$NEW_SERVER" >&2; exit 2 ;;
esac

changed=0

# 改写 KEY=VALUE（可带 export 前缀）；缺失时追加。值不含特殊字符，不加引号，shell 和 systemd 都能读。
set_key() {
  file="$1"; key="$2"; value="$3"
  if grep -Eq "^(export )?${key}=" "$file"; then
    sed -i.bak -E "s#^(export )?${key}=.*#\\1${key}=${value}#" "$file" && rm -f "$file.bak"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

switch_file() {
  file="$1"
  grep -q '^\(export \)\{0,1\}CF_MONITOR_TOKEN=' "$file" 2>/dev/null || return 1
  old="$(sed -n -E 's/^(export )?CF_MONITOR_SERVER=//p' "$file" | head -n 1)"
  if [ "$DRY_RUN" = 1 ]; then
    echo "[dry-run] $file：$old -> $NEW_SERVER（mode=http）"
    return 0
  fi
  set_key "$file" CF_MONITOR_SERVER "$NEW_SERVER"
  set_key "$file" CF_MONITOR_MODE http
  echo "已修改 $file：$old -> $NEW_SERVER（mode=http）"
  return 0
}

restart_note() {
  if [ "$DRY_RUN" = 1 ]; then echo "[dry-run] 重启 $1"; return 1; fi
  return 0
}

# systemd：/etc/<服务名>.env
for file in /etc/cf-vps-monitor-agent*.env; do
  [ -f "$file" ] || continue
  switch_file "$file" || continue
  changed=$((changed + 1))
  service="$(basename "$file" .env)"
  if restart_note "$service" && command -v systemctl >/dev/null 2>&1; then
    { systemctl restart "$service" && echo "  已重启 $service"; } || echo "  重启失败，请手动执行：systemctl restart $service" >&2
  fi
done

# OpenRC：/etc/conf.d/<服务名>
for file in /etc/conf.d/cf-vps-monitor-agent*; do
  [ -f "$file" ] || continue
  switch_file "$file" || continue
  changed=$((changed + 1))
  service="$(basename "$file")"
  if restart_note "$service" && command -v rc-service >/dev/null 2>&1; then
    { rc-service "$service" restart && echo "  已重启 $service"; } || echo "  重启失败，请手动执行：rc-service $service restart" >&2
  fi
done

# 用户模式：~/.config/cf-vps-monitor/<实例>.env，程序在 ~/.local/share/cf-vps-monitor/<实例>/
config_home="${XDG_CONFIG_HOME:-${HOME:-/nonexistent}/.config}"
data_home="${XDG_DATA_HOME:-${HOME:-/nonexistent}/.local/share}"
for file in "$config_home"/cf-vps-monitor/*.env; do
  [ -f "$file" ] || continue
  switch_file "$file" || continue
  changed=$((changed + 1))
  dir="$data_home/cf-vps-monitor/$(basename "$file" .env)"
  if restart_note "$dir" && [ -x "$dir/start.sh" ]; then
    [ ! -x "$dir/stop.sh" ] || "$dir/stop.sh" || true
    { "$dir/start.sh" && echo "  已重启 $dir"; } || echo "  启动失败，请手动执行：$dir/start.sh" >&2
  fi
done

if [ "$changed" = 0 ]; then
  echo "没有找到已安装的 Agent 配置。若是 root 安装请用 root 运行；自定义安装目录的实例请在后台复制安装命令重装。" >&2
  exit 1
fi
echo "完成：共切换 $changed 个实例。约 1 分钟内应在新面板显示在线。"
