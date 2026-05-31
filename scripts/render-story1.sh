#!/usr/bin/env bash
# 故事一出片 —— 4K(--scale=2 → 3840×2160)/ 60fps,内挂 + 干净母带 + SRT。
#
#   bash scripts/render-story1.sh            # 全部 4 个母带 + SRT
#   bash scripts/render-story1.sh burned     # 只出内挂版(2 个)
#   bash scripts/render-story1.sh clean       # 只出干净母带(2 个)+ SRT
#   bash scripts/render-story1.sh srt         # 只重生成 SRT
#
# 注:4K@60fps 渲染较慢(单个约 15–20 分钟,全 4 个约 1 小时)。产物在 out/。

set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-all}"
ENTRY="src/studio/index.ts"
# 画质:4K 超采样 + 高码率 + 近无损中间帧
QUALITY="--scale=2 --crf=16 --jpeg-quality=100 --log=info"

gen_srt() {
  echo "▶ 生成 SRT 外挂字幕…"
  npx tsx scripts/voice/export-srt.ts agent-loop zh,en
}

render() {
  # $1 compositionId  $2 输出名  $3 lang  $4 caption(true/false)
  echo "▶ 渲染 $2  (lang=$3 · caption=$4 · 4K/60fps)…"
  ( cd client && npx remotion render "$ENTRY" "$1" "../out/$2" \
      --props="{\"lang\":\"$3\",\"caption\":$4}" $QUALITY )
}

burned() {
  render AgentLoopStory   agent-loop-zh.mp4 zh true
  render AgentLoopStoryEn agent-loop-en.mp4 en true
}

clean() {
  render AgentLoopStory   agent-loop-zh-clean.mp4 zh false
  render AgentLoopStoryEn agent-loop-en-clean.mp4 en false
  gen_srt
}

case "$MODE" in
  all)    burned; clean ;;
  burned) burned ;;
  clean)  clean ;;
  srt)    gen_srt ;;
  *) echo "未知参数:$MODE(可用 all|burned|clean|srt)"; exit 2 ;;
esac

echo ""
echo "✓ 完成。out/ 下产物:"
echo "  内挂(硬字幕):  agent-loop-zh.mp4 / agent-loop-en.mp4"
echo "  干净母带(无字幕):agent-loop-zh-clean.mp4 / agent-loop-en-clean.mp4"
echo "  外挂字幕:        agent-loop-zh.srt / agent-loop-en.srt"
