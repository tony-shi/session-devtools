import { useEffect, useState } from "react";
import { api } from "./api";
import { DigestPanel } from "./components/DigestPanel";
import { Header } from "./components/Header";
import { SessionList } from "./components/SessionList";
import { SummaryCards } from "./components/SummaryCards";
import type { DigestData, SessionsResponse, SummaryData } from "./types";

function getInitialDate(): string {
  const hash = window.location.hash.slice(1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(hash)) return hash;
  return new Date().toISOString().slice(0, 10);
}

export default function App() {
  const [date, setDate] = useState(getInitialDate);
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [sessions, setSessions] = useState<SessionsResponse | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [digest, setDigest] = useState<DigestData | null>(null);
  const [digestLoading, setDigestLoading] = useState(true);

  function handleDateChange(newDate: string) {
    setDate(newDate);
    window.location.hash = newDate;
  }

  useEffect(() => {
    setSummaryLoading(true);
    setSessionsLoading(true);
    setDigestLoading(true);
    setSummary(null);
    setSessions(null);
    setDigest(null);

    api.summary(date)
      .then(setSummary)
      .catch(console.error)
      .finally(() => setSummaryLoading(false));

    api.sessions(date)
      .then(setSessions)
      .catch(console.error)
      .finally(() => setSessionsLoading(false));

    api.digest(date)
      .then(setDigest)
      .catch(console.error)
      .finally(() => setDigestLoading(false));
  }, [date]);

  return (
    <div className="min-h-screen bg-gray-50">
      <Header date={date} onDateChange={handleDateChange} />
      <main className="max-w-4xl mx-auto px-6 py-6 space-y-4">
        <SummaryCards data={summary} loading={summaryLoading} />
        <DigestPanel
          date={date}
          data={digest}
          loading={digestLoading}
          onRefresh={setDigest}
        />
        <SessionList data={sessions} loading={sessionsLoading} date={date} />
      </main>
    </div>
  );
}
