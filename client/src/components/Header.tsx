import { useState } from "react";
import { api } from "../api";

interface Props {
  date: string;
  onDateChange: (date: string) => void;
}

function addDays(date: string, n: number): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function Header({ date, onDateChange }: Props) {
  const today = new Date().toISOString().slice(0, 10);
  const isToday = date === today;
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");

  async function handleSync() {
    setSyncing(true);
    setSyncMsg("");
    try {
      const r = await api.sync();
      setSyncMsg(`synced ${r.synced}, skipped ${r.skipped}`);
      setTimeout(() => setSyncMsg(""), 4000);
    } catch {
      setSyncMsg("sync failed");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <header className="flex items-center justify-between px-6 py-4 bg-white border-b border-gray-200 sticky top-0 z-10">
      <div className="flex items-center gap-3">
        <div className="w-7 h-7 rounded-lg bg-violet-600 flex items-center justify-center">
          <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
        </div>
        <span className="font-semibold text-gray-900 text-sm">Session Dashboard</span>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => onDateChange(addDays(date, -1))}
          className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
          title="Previous day"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <input
          type="date"
          value={date}
          onChange={(e) => e.target.value && onDateChange(e.target.value)}
          className="text-sm font-medium text-gray-700 border border-gray-200 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-violet-500"
        />

        <button
          onClick={() => onDateChange(addDays(date, 1))}
          disabled={isToday}
          className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500 hover:text-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Next day"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>

        {!isToday && (
          <button
            onClick={() => onDateChange(today)}
            className="text-xs px-2 py-1 rounded-md bg-violet-50 text-violet-600 hover:bg-violet-100 transition-colors font-medium"
          >
            今天
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        {syncMsg && <span className="text-xs text-gray-500">{syncMsg}</span>}
        <button
          onClick={handleSync}
          disabled={syncing}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-gray-100 hover:bg-gray-200 text-gray-600 disabled:opacity-50 transition-colors"
        >
          <svg
            className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {syncing ? "同步中…" : "同步"}
        </button>
      </div>
    </header>
  );
}
