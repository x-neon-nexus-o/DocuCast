import { useEffect, useState } from "react";
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "/api";

function timeAgo(unixSeconds) {
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

/**
 * Episode history: fetches the user's saved generations from /episodes and
 * lets them reopen one (fetching audio lazily from /episodes/:id) or delete it.
 */
export default function HistorySection({ authToken, onOpenEpisode, refreshKey }) {
  const [episodes, setEpisodes] = useState(null); // null = loading
  const [error, setError] = useState("");
  const [openingId, setOpeningId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  useEffect(() => {
    let isActive = true;
    setEpisodes(null);
    setError("");
    axios
      .get(`${API_URL}/episodes`, {
        headers: { Authorization: `Bearer ${authToken}` },
        timeout: 15_000,
      })
      .then(({ data }) => {
        if (isActive) setEpisodes(data.episodes || []);
      })
      .catch((err) => {
        if (!isActive) return;
        setEpisodes([]);
        setError(err?.response?.data?.detail || err?.message || "Could not load history.");
      });
    return () => {
      isActive = false;
    };
  }, [authToken, refreshKey]);

  const openEpisode = async (id) => {
    setOpeningId(id);
    try {
      const { data } = await axios.get(`${API_URL}/episodes/${id}`, {
        headers: { Authorization: `Bearer ${authToken}` },
        timeout: 30_000,
      });
      onOpenEpisode({
        script: data.script,
        audio_base64: data.audio_base64,
        audio_engine: data.audio_engine,
        audio_mime: data.audio_mime,
        provider: data.provider,
        options: data.options,
        analysis: data.analysis,
        filename: data.filename,
        episode_id: data.id,
      });
    } catch (err) {
      setError(err?.response?.data?.detail || err?.message || "Could not open this episode.");
    } finally {
      setOpeningId(null);
    }
  };

  const deleteEpisode = async (id) => {
    setDeletingId(id);
    try {
      await axios.delete(`${API_URL}/episodes/${id}`, {
        headers: { Authorization: `Bearer ${authToken}` },
        timeout: 15_000,
      });
      setEpisodes((eps) => (eps || []).filter((e) => e.id !== id));
    } catch (err) {
      setError(err?.response?.data?.detail || err?.message || "Could not delete this episode.");
    } finally {
      setDeletingId(null);
    }
  };

  if (episodes === null) {
    return (
      <section className="glass rounded-[1.75rem] p-5 sm:p-7">
        <h3 className="font-display text-lg font-semibold">Your episodes</h3>
        <p className="mt-3 text-sm text-dim animate-pulse-soft">Loading history…</p>
      </section>
    );
  }

  if (!episodes.length) {
    return (
      <section className="glass rounded-[1.75rem] p-5 sm:p-7">
        <h3 className="font-display text-lg font-semibold">Your episodes</h3>
        <p className="mt-3 text-sm text-dim">
          Nothing here yet — generated podcasts are saved automatically and appear here.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="history-heading" className="glass rounded-[1.75rem] p-5 sm:p-7">
      <div className="flex items-center justify-between gap-3">
        <h3 id="history-heading" className="font-display text-lg font-semibold">
          Your <span className="text-aurora">episodes</span>
        </h3>
        <span className="rounded-full border border-white/15 px-3 py-1 text-[11px] font-semibold text-dim">
          {episodes.length} saved
        </span>
      </div>

      {error && (
        <p role="alert" className="mt-3 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2.5 text-xs text-red-200">
          {error}
        </p>
      )}

      <div className="panel-scroll mt-4 grid max-h-96 gap-2.5 overflow-y-auto pr-1">
        {episodes.map((ep) => (
          <div
            key={ep.id}
            className="flex items-center gap-3 rounded-xl border border-white/10 bg-black/25 px-4 py-3 transition-colors hover:border-aurora-violet/40"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-ink">{ep.filename || "document"}</p>
              <p className="mt-0.5 text-[11px] text-dim">
                {timeAgo(ep.created_at)} · {ep.options?.mode === "solo" ? "solo" : "two hosts"} ·{" "}
                {ep.options?.length || "standard"} · {ep.provider}
                {ep.audio_engine ? ` · ${ep.audio_engine}` : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => openEpisode(ep.id)}
              disabled={openingId === ep.id}
              className="rounded-full border border-aurora-violet/50 bg-aurora-violet/10 px-3.5 py-1.5 text-[11px] font-semibold text-violet-200 transition-colors hover:bg-aurora-violet/25 disabled:opacity-50"
            >
              {openingId === ep.id ? "Opening…" : "↻ Open"}
            </button>
            <button
              type="button"
              onClick={() => deleteEpisode(ep.id)}
              disabled={deletingId === ep.id}
              aria-label={`Delete episode for ${ep.filename}`}
              className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] font-semibold text-dim transition-colors hover:text-red-300 hover:border-red-400/40 disabled:opacity-50"
            >
              {deletingId === ep.id ? "…" : "✕"}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
