import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import type { DigestData } from "../types";

interface Props {
  date: string;
  data: DigestData | null;
  loading: boolean;
  onRefresh: (data: DigestData) => void;
}

export function DigestPanel({ date, data, loading, onRefresh }: Props) {
  const { t, i18n } = useTranslation();
  const [requesting, setRequesting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll when generating
  useEffect(() => {
    if (data?.generating) {
      if (pollRef.current) return; // already polling
      pollRef.current = setInterval(async () => {
        try {
          const result = await api.digest(date, false);
          if (!result.generating) {
            clearInterval(pollRef.current!);
            pollRef.current = null;
            onRefresh(result);
          }
        } catch {
          // ignore transient errors
        }
      }, 4000);
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [data?.generating, date]);

  async function handleRegenerate() {
    setRequesting(true);
    try {
      const result = await api.digest(date, true);
      onRefresh(result); // will be generating:true, poll will pick it up
    } catch (e) {
      console.error(e);
    } finally {
      setRequesting(false);
    }
  }

  const isGenerating = data?.generating === true;
  const busy = requesting || loading || isGenerating;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-900">{t("digest.title")}</h2>
          {isGenerating && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-200 flex items-center gap-1">
              <svg className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {t("digest.generating")}
            </span>
          )}
          {!isGenerating && data?.mock && data.summary && (
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
          disabled={busy}
          className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-violet-50 text-violet-600 hover:bg-violet-100 disabled:opacity-50 transition-colors"
        >
          <svg
            className={`w-3 h-3 ${requesting ? "animate-spin" : ""}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {requesting ? t("digest.requesting") : t("digest.regenerate")}
        </button>
      </div>

      {loading ? (
        <div className="space-y-2">
          <div className="h-4 bg-gray-200 rounded animate-pulse w-3/4" />
          <div className="h-4 bg-gray-200 rounded animate-pulse w-full" />
          <div className="h-4 bg-gray-200 rounded animate-pulse w-5/6" />
        </div>
      ) : isGenerating ? (
        <div className="space-y-2">
          <div className="h-4 bg-blue-100 rounded animate-pulse w-3/4" />
          <div className="h-4 bg-blue-100 rounded animate-pulse w-full" />
          <div className="h-4 bg-blue-100 rounded animate-pulse w-5/6" />
          <p className="text-xs text-blue-400 mt-1">{t("digest.llmGenerating")}</p>
        </div>
      ) : !data?.summary ? (
        <p className="text-sm text-gray-400">
          {data?.pair_count === 0 ? t("digest.noData") : t("digest.noReport")}
        </p>
      ) : (
        <div>
          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{data.summary}</p>
          {data.generated_at && (
            <p className="text-xs text-gray-400 mt-3">
              {t("digest.generatedAt", { time: new Date(data.generated_at).toLocaleString(i18n.language) })}
              {data.pair_count > 0 && t("digest.pairCount", { count: data.pair_count })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
