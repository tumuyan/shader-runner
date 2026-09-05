#!/usr/bin/env bash
#
# CI / 新机器的一次性环境准备。
#
#   bash scripts/ci-setup.sh              # 完整 setup，最后自检
#   bash scripts/ci-setup.sh --no-verify  # 只装不验
#   bash scripts/ci-setup.sh --no-deps    # 跳过系统依赖（镜像里已有，或没有 root）
#   bash scripts/ci-setup.sh --no-npm     # 跳过 npm 依赖（已由 actions/setup-node 等装好）
#
# 装三样：npm 依赖 → Playwright Chromium → Chromium 的系统库。
#
# 最后一定跑一次 --self-test：装完不等于能跑。缺系统库时 Chromium 装得上但启动
# 即崩，glslangValidator 的二进制也可能丢掉执行位 —— 只有真跑一遍才知道。
# 幂等，可重复执行；已就绪的步骤会跳过。
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

VERIFY=1
INSTALL_DEPS=1
INSTALL_NPM=1
for a in "$@"; do
  case "$a" in
    --no-verify) VERIFY=0 ;;
    --no-deps)   INSTALL_DEPS=0 ;;
    --no-npm)    INSTALL_NPM=0 ;;
    # 只打到注释块结束（第 15 行）—— 再往下是真的 shell 代码，会被原样打印出来
    -h|--help)   sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $a（可用 --no-verify / --no-deps / --no-npm）" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()  { printf '    ✓ %s\n' "$*"; }
skip(){ printf '    · %s（跳过）\n' "$*"; }

# 直接调本地 cli.js，不走 npx：npx 在 .bin 链接缺失时会去联网下载，
# 慢且在离线 CI 上直接失败。cli.js 就在包里，用它最稳。
# 用数组而不是函数，因为 sudo 调不了 shell 函数。
PW_CLI=(npx playwright)
if [ -f node_modules/playwright/cli.js ]; then
  PW_CLI=(node "$ROOT/node_modules/playwright/cli.js")
fi

# ---------------------------------------------------------------- npm 依赖
say "安装 npm 依赖"
if [ "$INSTALL_NPM" -eq 0 ]; then
  skip "已通过 --no-npm 指定跳过"
else
  # 有 lockfile 就用 ci（严格、可复现）；否则退回 install
  if [ -f package-lock.json ]; then
    npm ci --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
  ok "npm 依赖就绪"
fi

# ---------------------------------------------------------------- Chromium
say "安装 Playwright Chromium"
# 幂等：已下载且版本匹配时 playwright 自己会跳过，这里只是避免多余的启动开销
if node -e "require.resolve('playwright')" 2>/dev/null; then
  "${PW_CLI[@]}" install chromium
  ok "Chromium 就绪"
else
  skip "未安装 playwright 包（npm i -D playwright）"
fi

# ---------------------------------------------------------------- 系统依赖
say "安装 Chromium 系统依赖"
install_system_deps() {
  case "$(uname -s)" in
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        if [ "$(id -u)" -eq 0 ]; then
          apt-get update -qq
          "${PW_CLI[@]}" install-deps chromium
        elif command -v sudo >/dev/null 2>&1; then
          sudo apt-get update -qq
          sudo -E "${PW_CLI[@]}" install-deps chromium
        else
          echo "    需要 root 或 sudo 才能安装系统库" >&2
          return 1
        fi
      else
        skip "非 Debian 系，请自行安装 Chromium 依赖"
        return 0
      fi
      ;;
    Darwin)
      skip "macOS 通常无需额外系统依赖"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      skip "Windows 通常无需额外系统依赖"
      ;;
    *)
      skip "未知平台 $(uname -s)"
      ;;
  esac
}

if [ "$INSTALL_DEPS" -eq 1 ]; then
  if ! install_system_deps; then
    echo "" >&2
    echo "系统依赖安装失败。可以加 --no-deps 跳过（若镜像已预装系统库）：" >&2
    echo "  bash scripts/ci-setup.sh --no-deps" >&2
    exit 1
  fi
  ok "系统依赖就绪"
else
  skip "已通过 --no-deps 指定跳过"
fi

# ---------------------------------------------------------------- 自检
if [ "$VERIFY" -eq 0 ]; then
  say "跳过自检（--no-verify）"
  exit 0
fi

say "环境自检"
if node scripts/check-glsl.js --self-test; then
  ok "环境可用"
else
  echo "" >&2
  echo "自检未通过 —— 环境不完整，check 可能静默降级到弱后端。" >&2
  echo "若确认无需浏览器后端（可容忍结论强度较低），可显式指定：" >&2
  echo "  node scripts/check-glsl.js --backend glslang" >&2
  exit 1
fi

say "完成"
echo "    npm run check        # 总校验（含 GLSL 运行校验）"
echo "    npm run glsl:check   # 只跑 GLSL 运行校验"