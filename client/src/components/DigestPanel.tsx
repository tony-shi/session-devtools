import { useState } from "react";
import { api } from "../api";
import type { DigestData } from "../types";

interface Props {
  date: string;
  data: DigestData | null;
  loading: boolean;
  onRefresh: (data: DigestData) => void;
}

export function DigestPanel({ date, data, loading, onRefresh }: Props) {
  const [regenerating, setRegenerating] = useState(false);

  async function handleRegenerate() {
    setRegenerating(true);
    try {
      const result = await api.digest(date, true);
      onRefresh(result);
    } catch (e) {
      console.error(e);
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-900">LLM 日报</h2>
          {data?.mock && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 border border-amber-200">
              mock
            </span>
          )}
          {data?.stale && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-red-50 text-red-600 border border-red-200">
              stale
            </span>
          )}
        </div>
        <button
          onClick={handleRegenerate}
          disabled={regenerating || loading}
          className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-violet-50 text-violet-600 hover:bg-violet-100 disabled:opacity-50 transition-colors"
        >
          <svg
            className={`w-3 h-3 ${regenerating ? "animate-spin" : ""}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {regenerating ? "生成中…" : "重新生成"}
        </button>
      </div>

      {loading ? (
        <div className="space-y-2">
          <div className="h-4 bg-gray-200 rounded animate-pulse w-3/4" />
          <div className="h-4 bg-gray-200 rounded animate-pulse w-full" />
          <div className="h-4 bg-gray-200 rounded animate-pulse w-5/6" />
        </div>
      ) : !data || !data.summary ? (
        <p className="text-sm text-gray-400">
          {data?.pair_count === 0 ? "当天无会话数据" : "暂无日报，点击重新生成"}
        </p>
      ) : (
        <div>
          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{data.summary}</p>
          {data.generated_at && (
            <p className="text-xs text-gray-400 mt-3">
              生成于 {new Date(data.generated_at).toLocaleString("zh-CN")}
              {data.pair_count > 0 && `，共 ${data.pair_count} 对对话`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
