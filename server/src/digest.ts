import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getDb, initDigestSchema, serializeWrite } from "./db";

// ── Config ────────────────────────────────────────────────────────────────────

const DIGEST_CFG_PATH =
  process.env.DIGEST_CFG ?? join(import.meta.dirname, "..", "..", "digest.cfg");

const PROMPT_CHAR_BUDGET = parseInt(process.env.DIGEST_PROMPT_BUDGET ?? "1200000");

const RETRY_DELAYS = [2, 5, 10, 10, 10, 10, 10, 10, 10, 10]; // seconds

interface DigestCfg {
  base_url: string;
  token: string;
  model: string;
  max_tokens: number;
  enabled: boolean;
}

function parseIni(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    result[key] = val;
  }
  return result;
}

export function loadDigestCfg(): DigestCfg {
  let ini: Record<string, string> = {};
  if (existsSync(DIGEST_CFG_PATH)) {
    try {
      ini = parseIni(readFileSync(DIGEST_CFG_PATH, "utf-8"));
    } catch {
      // ignore
    }
  }

  return {
    base_url: process.env.ANTHROPIC_BASE_URL ?? ini.base_url ?? "https://api.anthropic.com",
    token: process.env.ANTHROPIC_API_KEY ?? ini.token ?? "",
    model: ini.model ?? "claude-haiku-4-5-20251001",
    max_tokens: parseInt(ini.max_tokens ?? "512"),
    enabled: (ini.enabled ?? "false").toLowerCase() === "true",
  };
}

// ── Turn pairs ────────────────────────────────────────────────────────────────

interface TurnPair {
  id: string;
  session_id: string;
  tool: string;
  project: string;
  date: string;
  user_content: string;
  user_ts: string;
  assistant_final: string | null;
  assistant_ts: string | null;
}

export function fetchTurnPairsForDate(date: string): TurnPair[] {
  const db = getDb();
  initDigestSchema();
  return db
    .prepare("SELECT * FROM turn_pairs WHERE date = ? ORDER BY user_ts")
    .all(date) as TurnPair[];
}

// ── Prompt building ───────────────────────────────────────────────────────────

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return "(empty)";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function buildDigestPrompt(date: string, pairs: TurnPair[]): string {
  // Group by tool + project
  const groups: Record<string, TurnPair[]> = {};
  for (const p of pairs) {
    const key = `${p.tool}/${p.project}`;
    (groups[key] ??= []).push(p);
  }

  let body = `日期：${date}\n\n`;
  for (const [key, items] of Object.entries(groups)) {
    body += `## ${key}\n`;
    for (const item of items) {
      body += `\nQ: ${truncate(item.user_content, 300)}\n`;
      body += `A: ${truncate(item.assistant_final, 300)}\n`;
    }
    body += "\n";
  }

  if (body.length > PROMPT_CHAR_BUDGET) {
    body = body.slice(0, PROMPT_CHAR_BUDGET) + "\n[内容已截断]\n";
  }

  return (
    `你是一个 AI 工作助手，请根据以下 AI 编程工具的对话记录，生成一份简洁的中文工作日报。\n` +
    `要求：不超过 300 字，按项目分组，突出重点工作内容。\n\n` +
    body
  );
}

// ── LLM call ──────────────────────────────────────────────────────────────────

async function callLlmOnce(prompt: string, cfg: DigestCfg): Promise<string> {
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  const fetchOptions: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.token}`,
      "anthropic-version": "2023-06-01",
      "X-Working-Dir": process.cwd(),
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: cfg.max_tokens,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(120_000),
  };

  // Node fetch supports proxy via env automatically; no special handling needed
  const res = await fetch(`${cfg.base_url}/v1/messages`, fetchOptions);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM API error ${res.status}: ${body}`);
  }
  const data = await res.json() as any;
  return data?.content?.[0]?.text ?? "";
}

export async function callLlm(
  prompt: string,
  cfg: DigestCfg,
): Promise<{ summary: string; isMock: boolean }> {
  if (!cfg.enabled || !cfg.token) {
    return { summary: "[mock] LLM 未启用，请在 digest.cfg 中配置 token 和 enabled=true", isMock: true };
  }

  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
    try {
      const summary = await callLlmOnce(prompt, cfg);
      return { summary, isMock: false };
    } catch (e: any) {
      console.warn(`[digest] LLM attempt ${attempt + 1} failed: ${e?.message}`);
      if (attempt < RETRY_DELAYS.length - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt] * 1000));
      }
    }
  }

  return { summary: "[ERROR] LLM 调用失败，请检查网络和 token 配置", isMock: true };
}

// ── Generate digest ───────────────────────────────────────────────────────────

export async function generateDigest(
  date: string,
  force = false,
): Promise<{
  date: string;
  summary: string | null;
  pair_count: number;
  model: string;
  mock: boolean;
  generated_at: string | null;
  stale: boolean;
  cached: boolean;
}> {
  const db = getDb();
  initDigestSchema();

  // Check cache
  if (!force) {
    const cached = db
      .prepare("SELECT * FROM daily_digest WHERE date = ? AND stale = 0")
      .get(date) as { summary: string; pair_count: number; model: string; mock: number; generated_at: string; stale: number } | undefined;
    if (cached) {
      return {
        date,
        summary: cached.summary,
        pair_count: cached.pair_count,
        model: cached.model,
        mock: cached.mock === 1,
        generated_at: cached.generated_at,
        stale: false,
        cached: true,
      };
    }
  }

  const pairs = fetchTurnPairsForDate(date);
  if (pairs.length === 0) {
    return {
      date,
      summary: null,
      pair_count: 0,
      model: "",
      mock: true,
      generated_at: null,
      stale: false,
      cached: false,
    };
  }

  const cfg = loadDigestCfg();
  const prompt = buildDigestPrompt(date, pairs);
  const { summary, isMock } = await callLlm(prompt, cfg);
  const generatedAt = new Date().toISOString();

  await serializeWrite(() => {
    db.prepare(`
      INSERT OR REPLACE INTO daily_digest (date, summary, pair_count, model, mock, generated_at, stale)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(date, summary, pairs.length, cfg.model, isMock ? 1 : 0, generatedAt);
  });

  return {
    date,
    summary,
    pair_count: pairs.length,
    model: cfg.model,
    mock: isMock,
    generated_at: generatedAt,
    stale: false,
    cached: false,
  };
}

// ── Find missing digests ──────────────────────────────────────────────────────

export function findDatesMissingDigest(): string[] {
  const db = getDb();
  initDigestSchema();
  const rows = db
    .prepare(`
      SELECT DISTINCT date(started_at) AS date FROM sessions
      WHERE started_at IS NOT NULL
        AND date(started_at) NOT IN (
          SELECT date FROM daily_digest WHERE stale = 0
        )
      ORDER BY date DESC
    `)
    .all() as { date: string }[];
  return rows.map((r) => r.date).filter(Boolean);
}

// ── Backfill ──────────────────────────────────────────────────────────────────

export async function backfillDigests(force = false): Promise<{
  generated: number;
  skipped: number;
  errors: number;
  dates: string[];
}> {
  const dates = force
    ? (getDb()
        .prepare(
          "SELECT DISTINCT date(started_at) AS date FROM sessions WHERE started_at IS NOT NULL ORDER BY date DESC",
        )
        .all() as { date: string }[])
        .map((r) => r.date)
        .filter(Boolean)
    : findDatesMissingDigest();

  let generated = 0, skipped = 0, errors = 0;
  const generatedDates: string[] = [];

  for (const date of dates) {
    try {
      const result = await generateDigest(date, force);
      if (result.cached) {
        skipped++;
      } else if (result.pair_count === 0) {
        skipped++;
      } else {
        generated++;
        generatedDates.push(date);
      }
    } catch (e: any) {
      console.warn(`[digest] Backfill failed for ${date}: ${e?.message}`);
      errors++;
    }
  }

  return { generated, skipped, errors, dates: generatedDates };
}
