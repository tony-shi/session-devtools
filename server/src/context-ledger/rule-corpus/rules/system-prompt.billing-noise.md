---
ruleId: claude-code.billing-noise.v1
slotId: system.billing
verifiedFor: "2.1.150"
sourceUnits: []
description: >-
  Claude Code 每次请求在 system[0] 主动注入的 attribution header(CC 源码称 attribution header,字面前缀伪装成 x-anthropic-billing-header)。含动态字段 cc_version(fingerprint)和 cch(attestation),内容不可复现;cc_entrypoint 标识运行入口/宿主环境(cli、IDE 扩展、mcp、github-action 等)。只匹配 system section——messages 里相同文本是集成逻辑携带,不命中此 rule。
stability: dynamic
displayName: "计费头"
summary: "Claude Code 发给服务端的版本/计费标记,不是给模型的提示内容"
dynamicSource: "cc_version 指纹 + cch 客户端验证,每次请求都变"
sourcemapRef: restored-src/src/constants/system.ts
materialization: presence
attribution:
  patternFromBody: true
  matchMode: regex
  mechanism: billing_noise_pattern
  category: billing_noise
  captureGroups:
    version: "cc_version 完整值(semver.hex_fingerprint),fingerprint 每次不同"
    entrypoint: "运行入口/宿主环境标签,标识谁拉起了 CLI 进程。由启动方经 CLAUDE_CODE_ENTRYPOINT 注入,进程级固定。源码可核实值:mcp、claude-code-github-action,缺省 unknown;常见外部值如 cli(交互终端)、IDE 扩展(vscode/jetbrains 等)、sdk-*、cron"
    cch: "attestation token(hex),NATIVE_CLIENT_ATTESTATION 开启时才出现"
    workload: "cc_workload tag,cron 等特殊场景才出现"
  notesTemplate:
    - format: "cc_version={version}"
      requireGroup: version
    - format: "cc_entrypoint={entrypoint}"
      requireGroup: entrypoint
    - format: "cch={cch}"
      requireGroup: cch
    - format: "cc_workload={workload}"
      requireGroup: workload
---

## 说明

Piebald 不把此 wrapper 当作独立 prompt 单元(它是 CLI 端的 billing header 注入),
`sourceUnits: []`。

CC 源码里函数/flag 都叫 attribution header(`getAttributionHeader()`、env
`CLAUDE_CODE_ATTRIBUTION_HEADER`、GrowthBook `tengu_attribution_header`);只有注入
进 system[0] 的字面前缀写成 `x-anthropic-billing-header:`,且它并非真正的 HTTP header,
而是塞进请求体 system 文本里的一行字符串。本 rule 的 displayName/category 跟字面前缀(billing)
对齐,语义上等价于官方的「归因头」。

`cc_entrypoint` 是运行入口/宿主环境标签:`system.ts:79` 为
`process.env.CLAUDE_CODE_ENTRYPOINT ?? 'unknown'`(注意源码缺省是 `unknown` 不是 `cli`;
user-agent 那条 `http.ts` 才兜底 `cli`),值由启动方注入、CC 自身不收敛。entrypoint 用
`[\w-]+` 而非 `\w+`,覆盖 kebab(`claude-vscode`、`claude-code-github-action` 等)。

## pattern

```regex
^x-anthropic-billing-header: cc_version=(?<version>\d+\.\d+\.\d+\.[0-9a-f]+); cc_entrypoint=(?<entrypoint>[\w-]+);(?: cch=(?<cch>[0-9a-f]+);)?(?: cc_workload=(?<workload>\S+);)?(?:; \w+=[^;]+)*\s*$
```
