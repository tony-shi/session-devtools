// 把模块和真实 DB / parser 串起来的胶水层。所有 getDb / parser 引用集中在
// 这里——proxy-visibility/ 的其他文件保持对外部世界无感。
import { getDb } from "../db.ts";
import { parseSessionDrilldown } from "../session-drilldown-parser.ts";
import type { SessionMeta, VisibilityDeps } from "./service.ts";

type SessionMetaRow = {
  session_id: string;
  source_file: string;
  file_mtime: number;
  source_present: number;
};

export function realVisibilityDeps(): VisibilityDeps {
  return {
    loadMetas(sessionIds: string[]): Map<string, SessionMeta> {
      const out = new Map<string, SessionMeta>();
      if (sessionIds.length === 0) return out;
      const db = getDb();
      const placeholders = sessionIds.map(() => "?").join(",");
      const rows = db.prepare(`
        SELECT session_id, source_file, file_mtime, source_present
        FROM sessions_meta_v2
        WHERE session_id IN (${placeholders})
      `).all(sessionIds) as SessionMetaRow[];
      for (const r of rows) {
        out.set(r.session_id, {
          sessionId: r.session_id,
          sourceFile: r.source_file,
          fileMtime: r.file_mtime,
          sourcePresent: r.source_present !== 0,
        });
      }
      return out;
    },

    computeRenderedSet(meta: SessionMeta): Set<string> {
      const db = getDb();
      const row = db.prepare(`SELECT * FROM sessions_meta_v2 WHERE session_id = ?`)
        .get(meta.sessionId) as Record<string, unknown> | undefined;
      if (!row) return new Set();
      const drilldown = parseSessionDrilldown(meta.sourceFile, meta.sessionId, row, db);
      const set = new Set<string>();
      for (const turn of drilldown.turns) {
        for (const call of turn.calls) {
          if (call.apiRequestId) set.add(call.apiRequestId);
        }
      }
      return set;
    },
  };
}
