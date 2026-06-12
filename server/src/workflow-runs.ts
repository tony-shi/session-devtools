// ─── Workflow run 工件读取（旁路模块，纯 fs，无 DB / parser 依赖）──────────────
// Claude Code dynamic workflow（Workflow tool）在 session 目录下留下三类工件：
//
//   <sessionDir>/workflows/wf_<runId>.json           run 汇总（终止时一次性写出）
//   <sessionDir>/workflows/scripts/<name>-<runId>.js 脚本源码（wf json.script 的冗余副本）
//   <sessionDir>/subagents/workflows/<runId>/        journal.jsonl + agent-<id>.jsonl ×N
//                                                    + agent-<id>.meta.json（仅 {agentType}）
//
// 完结性约定（实测 CC 2.1.167-2.1.170）：wf_<runId>.json 在 run 终止
// （completed / killed）时才写出 —— 文件存在即 run 已完结。进行中的 run 只有
// agents 目录 + 脚本，没有这个 json，本模块直接不可见（产品决策：只渲染完结
// 场景，不追实时性，换稳定性与正确性）。
//
// resume 语义（同上实测）：
//   - resume 复用 runId、发新 taskId：runId 标识"逻辑 run"，taskId 标识"一次物理执行"。
//   - wf json 被末次执行整体覆盖（last-write-wins）：durationMs / totalTokens /
//     taskId / startTime 是"末次物理执行"口径；agentCount 与 workflowProgress 是
//     "逻辑 run"口径 —— cached=true 的条目引用上一轮的 agentId，其转录文件来自上一轮。
//   - resume 回放是"最长不变前缀"：目录里可能存在不被最终 workflowProgress 引用的
//     转录文件（上一轮失败 / 被前缀规则作废的 agent）。这些 superseded 转录只计数
//     （supersededAgentCount），不展开成 agent 条目。
//   - journal.jsonl 纯追加：{type:"started"|"result", key, agentId, result?}，无时间戳。
//     result 行按 agentId 取末次出现（防御重复），是 agent 结构化返回值的权威来源
//     （与 wf json result 子结构、agent 转录尾部 StructuredOutput 三处冗余一致）。

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

/** wf json `workflowProgress` 中 type === "workflow_agent" 的条目（按实测字段建模）。 */
export interface WorkflowProgressAgent {
  agentId: string;
  /** agent() 调用的展示标签（opts.label 或 prompt 摘要）。 */
  label: string;
  /** 1-based phase 序号；缺失时 null。 */
  phaseIndex: number | null;
  phaseTitle: string;
  model: string;
  /** 实测只见 "done"；原样透传，不枚举锁死。 */
  state: string;
  /** true = resume 时从上一轮 journal 回放（转录文件来自上一轮执行）。 */
  cached: boolean;
  /** epoch ms。注意 cached 条目记录的是"回放发生时刻"，不是原始执行时刻。 */
  startedAt: number | null;
  promptPreview: string;
  resultPreview: string;
}

/** 一个已完结 workflow run 的磁盘工件聚合视图。 */
export interface WorkflowRunDisk {
  runId: string;
  workflowName: string;
  status: string;
  taskId: string;
  startTime: number;
  /** wf json 顶层 `timestamp` —— run 终止写出时刻（ISO）。 */
  completedAt: string;
  durationMs: number;
  /** 逻辑 run 的 agent() 调用数（含 cached 回放），≠ 目录转录文件数。 */
  agentCount: number;
  /** 末次物理执行口径（只计实跑 agent）。 */
  totalTokens: number;
  totalToolCalls: number;
  defaultModel: string;
  summary: string;
  error?: string;
  scriptPath: string;
  /** 内嵌脚本全文长度。脚本本体不进 drilldown payload，走专用 script 端点。 */
  scriptLength: number;
  /** Workflow tool `args` 入参（JSON.stringify 存档原值），缺省 undefined。 */
  args?: string;
  phases: Array<{ title: string; detail?: string }>;
  agents: WorkflowProgressAgent[];
  /** agentId → JSON.stringify(journal result)。string 结果原样、对象 stringify。 */
  journalResults: Map<string, string>;
  /** journal key → started agentId 序列（物理行序 = 尝试时间序）。attempt 槽位用。 */
  journalStartedByKey: Map<string, string[]>;
  /** journal 有 result 行的 agentId 集合（尝试成功判据）。 */
  journalResultAgentIds: Set<string>;
  /** agentId → journal started/result 物理行号。dataflow 的因果序约束用。 */
  journalStartedLine: Map<string, number>;
  journalResultLine: Map<string, number>;
  /** 目录下实际存在转录文件的 agentId 集合。 */
  transcriptAgentIds: Set<string>;
  /** 有转录文件但不被最终 workflowProgress 引用的 agent 数（superseded/失败）。 */
  supersededAgentCount: number;
  /** subagents/workflows/<runId>/ 绝对路径。 */
  agentsDir: string;
}

/** 读出 wf json 全文（含 script）。script 端点用；列表路径不要调它以免白读大字段。 */
export function readWorkflowRunJson(sessionDir: string, runId: string): Record<string, unknown> | null {
  const p = join(sessionDir, "workflows", `${runId}.json`);
  if (!existsSync(p)) return null;
  // 损坏（写出中途被 kill 等）≠ 不存在：这里是单 run 精确取数，吞错返回 null
  // 会变成误导性 404 把排查指向错误方向 —— fail fast 抛原因（列表路径
  // readWorkflowRunsFromDisk 对损坏 run 容错跳过，那是聚合语义，两者不同）。
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
  } catch (e) {
    throw Object.assign(
      new Error(`workflow run json unreadable: ${runId}.json (${(e as Error).message})`),
      { status: 500 },
    );
  }
}

function parseProgressAgents(raw: Record<string, unknown>): WorkflowProgressAgent[] {
  const progress = Array.isArray(raw.workflowProgress) ? raw.workflowProgress : [];
  const agents: WorkflowProgressAgent[] = [];
  for (const e of progress) {
    const p = e as Record<string, unknown>;
    if (p.type !== "workflow_agent" || typeof p.agentId !== "string") continue;
    agents.push({
      agentId: p.agentId,
      label: typeof p.label === "string" ? p.label : "",
      phaseIndex: typeof p.phaseIndex === "number" ? p.phaseIndex : null,
      phaseTitle: typeof p.phaseTitle === "string" ? p.phaseTitle : "",
      model: typeof p.model === "string" ? p.model : "",
      state: typeof p.state === "string" ? p.state : "",
      cached: p.cached === true,
      startedAt: typeof p.startedAt === "number" ? p.startedAt : null,
      promptPreview: typeof p.promptPreview === "string" ? p.promptPreview : "",
      resultPreview: typeof p.resultPreview === "string" ? p.resultPreview : "",
    });
  }
  return agents;
}

function listTranscriptAgentIds(agentsDir: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(agentsDir)) return ids;
  try {
    for (const f of readdirSync(agentsDir)) {
      const m = /^agent-([A-Za-z0-9]+)\.jsonl$/.exec(f);
      if (m) ids.add(m[1]);
    }
  } catch { /* 目录读失败按无转录处理 */ }
  return ids;
}

// journal.jsonl 全量解析：result 载荷 + attempt 槽位序列。
//
// attempt 槽位模型（05 文档 §5）：journal key（链式哈希）是 agent() 调用槽位的
// 跨执行稳定身份。resume 重跑时同 key 以新 agentId 重新 started（纯追加），
// 所以"key → started agentId 序列（物理行序）"就是该槽位的尝试链；有 result
// 行的 agentId = 尝试成功，最终 workflowProgress 引用的 = 胜出尝试。
// cached 回放在新一轮不写任何 journal 行（实测），不会污染序列。
interface JournalData {
  /** agentId → 末次 result（string 原样 / 对象 stringify）—— 结构化返回值权威来源。 */
  results: Map<string, string>;
  /** key → started 的 agentId 序列（物理行序 = 尝试时间序）。 */
  startedByKey: Map<string, string[]>;
  /** 有 result 行的 agentId 集合（尝试成功判据）。 */
  resultAgentIds: Set<string>;
  /** agentId → started/result 行的物理行号（0-based）。journal 无时间戳，
   *  行序是唯一的因果序信号 —— dataflow 用"上游 result 行 < 下游 started 行"
   *  做依赖方向约束。 */
  startedLineByAgentId: Map<string, number>;
  resultLineByAgentId: Map<string, number>;
}

// 读失败 → 空结构（退化为只有 wf json 的 resultPreview，无 attempts 维度）。
function readJournal(agentsDir: string): JournalData {
  const data: JournalData = {
    results: new Map(), startedByKey: new Map(), resultAgentIds: new Set(),
    startedLineByAgentId: new Map(), resultLineByAgentId: new Map(),
  };
  const journalPath = join(agentsDir, "journal.jsonl");
  if (!existsSync(journalPath)) return data;
  let lines: string[];
  try {
    lines = readFileSync(journalPath, "utf-8").split("\n");
  } catch {
    return data;
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (typeof rec.agentId !== "string") continue;
    if (rec.type === "started" && typeof rec.key === "string") {
      const arr = data.startedByKey.get(rec.key) ?? [];
      arr.push(rec.agentId);
      data.startedByKey.set(rec.key, arr);
      data.startedLineByAgentId.set(rec.agentId, i);
    } else if (rec.type === "result") {
      data.resultAgentIds.add(rec.agentId);
      data.resultLineByAgentId.set(rec.agentId, i);
      const r = rec.result;
      // result 键缺失时 JSON.stringify(undefined) 返回 undefined（非 string），
      // 会污染 Map 契约 —— 显式跳过，下游回退 wf json 的 resultPreview。
      if (r === undefined) continue;
      data.results.set(rec.agentId, typeof r === "string" ? r : JSON.stringify(r));
    }
  }
  return data;
}

/** agent 转录首条 user 行的逐字 prompt。读失败/首行非 user 返回 null。 */
export function transcriptFirstPrompt(agentPath: string): string | null {
  try {
    const text = readFileSync(agentPath, "utf-8");
    const nl = text.indexOf("\n");
    const first = JSON.parse(nl === -1 ? text : text.slice(0, nl)) as {
      type?: string; message?: { content?: unknown };
    };
    if (first.type !== "user") return null;
    const c = first.message?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((b) => (b as { text?: string })?.text ?? "").join("");
    return null;
  } catch {
    return null;
  }
}

/**
 * agent 转录中第一条带 requestId 的 assistant 行的 requestId。
 * schema 端点用：同一 agent 的所有请求 tools 数组恒定（含 StructuredOutput
 * schema），任取一条即可经 proxy join 取回发送到 API 的 schema 真值。
 * 读失败/无 assistant 行返回 null。
 */
export function firstAssistantRequestId(agentPath: string): string | null {
  let text: string;
  try {
    text = readFileSync(agentPath, "utf-8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: { type?: string; requestId?: string };
    try { rec = JSON.parse(line) as { type?: string; requestId?: string }; } catch { continue; }
    if (rec.type === "assistant" && typeof rec.requestId === "string" && rec.requestId) {
      return rec.requestId;
    }
  }
  return null;
}

/** 转录首行 timestamp（epoch ms）。读/解析失败返回 null。 */
function transcriptFirstTimestamp(path: string): number | null {
  try {
    const text = readFileSync(path, "utf-8");
    const nl = text.indexOf("\n");
    const first = JSON.parse(nl === -1 ? text : text.slice(0, nl)) as { timestamp?: string };
    const ms = Date.parse(first.timestamp ?? "");
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function parsePhases(raw: Record<string, unknown>): Array<{ title: string; detail?: string }> {
  if (!Array.isArray(raw.phases)) return [];
  return (raw.phases as Array<Record<string, unknown>>)
    .filter((p) => typeof p?.title === "string")
    .map((p) => ({ title: p.title as string, ...(typeof p.detail === "string" ? { detail: p.detail } : {}) }));
}

/**
 * 扫描 <sessionDir>/workflows/wf_*.json，返回全部已完结 run 的工件聚合。
 * 单个 run 解析失败（json 损坏等）跳过该 run，不影响其余 —— 与 parser 各处
 * "best-effort 读 jsonl"的容错风格一致。按 startTime 升序（物理时间序）。
 */
export function readWorkflowRunsFromDisk(sessionDir: string): WorkflowRunDisk[] {
  const wfDir = join(sessionDir, "workflows");
  if (!existsSync(wfDir)) return [];
  let files: string[];
  try {
    files = readdirSync(wfDir).filter((f) => f.startsWith("wf_") && f.endsWith(".json"));
  } catch {
    return [];
  }

  const runs: WorkflowRunDisk[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(wfDir, file), "utf-8")) as Record<string, unknown>;
      const runId = typeof raw.runId === "string" ? raw.runId : file.replace(/\.json$/, "");
      // 生成端与校验端字符集绑死：runId 不合白名单（resolveSubAgentPaths 复合
      // 正则 / script 端点同此）会产出自己都路由不到的 agentFileId 死链 ——
      // 按损坏 run 的同款容错跳过。
      if (!/^wf_[A-Za-z0-9-]+$/.test(runId)) continue;

      const agents = parseProgressAgents(raw);
      const agentsDir = join(sessionDir, "subagents", "workflows", runId);
      const transcriptAgentIds = listTranscriptAgentIds(agentsDir);
      const journal = readJournal(agentsDir);
      const phases = parsePhases(raw);

      const referenced = new Set(agents.map((a) => a.agentId));
      const completedMs = Date.parse(typeof raw.timestamp === "string" ? raw.timestamp : "");
      let superseded = 0;
      for (const id of transcriptAgentIds) {
        if (referenced.has(id)) continue;
        // superseded 的语义是"上一轮失败/被 resume 前缀规则作废"。晚于 wf json
        // 写出时刻的孤儿转录属于正在进行中的下一次 resume —— 不计（该次执行
        // 完结覆盖 json 后会被重新归类）。
        if (Number.isFinite(completedMs)) {
          const ts = transcriptFirstTimestamp(join(agentsDir, `agent-${id}.jsonl`));
          if (ts !== null && ts > completedMs) continue;
        }
        superseded++;
      }

      runs.push({
        runId,
        workflowName: typeof raw.workflowName === "string" ? raw.workflowName : "",
        status: typeof raw.status === "string" ? raw.status : "unknown",
        taskId: typeof raw.taskId === "string" ? raw.taskId : "",
        startTime: typeof raw.startTime === "number" ? raw.startTime : 0,
        completedAt: typeof raw.timestamp === "string" ? raw.timestamp : "",
        durationMs: typeof raw.durationMs === "number" ? raw.durationMs : 0,
        agentCount: typeof raw.agentCount === "number" ? raw.agentCount : agents.length,
        totalTokens: typeof raw.totalTokens === "number" ? raw.totalTokens : 0,
        totalToolCalls: typeof raw.totalToolCalls === "number" ? raw.totalToolCalls : 0,
        defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : "",
        summary: typeof raw.summary === "string" ? raw.summary : "",
        ...(typeof raw.error === "string" ? { error: raw.error } : {}),
        scriptPath: typeof raw.scriptPath === "string" ? raw.scriptPath : "",
        scriptLength: typeof raw.script === "string" ? raw.script.length : 0,
        ...(raw.args !== undefined ? { args: JSON.stringify(raw.args) } : {}),
        phases,
        agents,
        journalResults: journal.results,
        journalStartedByKey: journal.startedByKey,
        journalResultAgentIds: journal.resultAgentIds,
        journalStartedLine: journal.startedLineByAgentId,
        journalResultLine: journal.resultLineByAgentId,
        transcriptAgentIds,
        supersededAgentCount: superseded,
        agentsDir,
      });
    } catch { /* 单个 run 解析失败跳过 */ }
  }

  runs.sort((a, b) => a.startTime - b.startTime);
  return runs;
}
