---
ruleId: claude-code.billing-noise.v1
slotId: system.billing
verifiedFor: "2.1.150"
sourceUnits: []
description: >-
  Claude Code 每次请求在 system[0] 主动注入的 attribution header。含动态字段 cc_version(fingerprint)和 cch(attestation),内容不可复现。只匹配 system section——messages 里相同文本是集成逻辑携带,不命中此 rule。
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
    entrypoint: "cc_entrypoint 值,如 'cli'(进程级固定)"
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
`sourceUnits: []`。entrypoint 用 `[\w-]+` 而非 `\w+`,覆盖 kebab(`claude-vscode` 等)。

## pattern

```regex
^x-anthropic-billing-header: cc_version=(?<version>\d+\.\d+\.\d+\.[0-9a-f]+); cc_entrypoint=(?<entrypoint>[\w-]+);(?: cch=(?<cch>[0-9a-f]+);)?(?: cc_workload=(?<workload>\S+);)?(?:; \w+=[^;]+)*\s*$
```
