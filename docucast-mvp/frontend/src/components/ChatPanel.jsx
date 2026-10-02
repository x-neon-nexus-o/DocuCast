import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "/api";

const SUGGESTED_QUESTIONS = [
  "What are the key numbers?",
  "What did the hosts skip that I should know?",
  "Explain the main idea in one sentence.",
];

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function VoiceReplyPlayer({ audioBase64, audioMime }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const src = `data:${audioMime || "audio/mpeg"};base64,${audioBase64}`;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    const onTime = () => setCurrent(audio.currentTime);
    const onMeta = () => setDuration(audio.duration || 0);
    const onEnd = () => setPlaying(false);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    audio.addEventListener("ended", onEnd);
    audio.play().then(() => setPlaying(true)).catch(() => {});
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("ended", onEnd);
    };
  }, [src]);

  const toggle = () => {
    if (!audioRef.current) return;
    if (playing) audioRef.current.pause();
    else audioRef.current.play().catch(() => {});
    setPlaying(!playing);
  };

  const skip = (seconds) => {
    if (audioRef.current) audioRef.current.currentTime = Math.max(0, Math.min(duration, audioRef.current.currentTime + seconds));
  };

  const cycleRate = () => {
    const rates = [1, 1.25, 1.5, 2, 0.75];
    const next = rates[(rates.indexOf(rate) + 1) % rates.length];
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const download = () => {
    const link = document.createElement("a");
    link.href = src;
    link.download = "docucast-answer.mp3";
    link.click();
  };

  return (
    <div className="glass-deep mt-3 rounded-2xl p-3.5">
      <audio ref={audioRef} src={src} preload="metadata" />
      <div className="flex items-center gap-3">
        <button type="button" onClick={toggle} aria-label={playing ? "Pause spoken answer" : "Play spoken answer"} className="btn-aurora grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm text-white">
          {playing ? "❚❚" : "▶"}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 text-[10px] text-dim">
            <span className="truncate">Spoken answer · DocuCast voice</span>
            <span className="shrink-0 tabular-nums">{formatTime(current)} / {formatTime(duration)}</span>
          </div>
          <input
            type="range"
            min="0"
            max={duration || 0}
            step="0.1"
            value={Math.min(current, duration || 0)}
            onChange={(event) => { if (audioRef.current) audioRef.current.currentTime = Number(event.target.value); }}
            className="seek mt-2 w-full"
            style={{ "--seek": `${duration ? (current / duration) * 100 : 0}%` }}
            aria-label="Seek through spoken answer"
          />
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => skip(-10)} className="chip-btn" aria-label="Back 10 seconds">↺ 10s</button>
        <button type="button" onClick={() => skip(10)} className="chip-btn" aria-label="Forward 10 seconds">10s ↻</button>
        <button type="button" onClick={cycleRate} className="chip-btn" aria-label={`Playback speed ${rate}x`}>{rate}×</button>
        <span className="flex-1" />
        <button type="button" onClick={download} className="chip-btn">⇩ Download</button>
      </div>
    </div>
  );
}

/* One chat bubble (user right, assistant left) */
function Bubble({ role, children, pending, audioBase64, audioMime }) {
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} animate-fade-in`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed ${
          isUser
            ? "rounded-br-sm border border-aurora-violet/40 bg-aurora-violet/15 text-ink"
            : "rounded-bl-sm border border-white/10 bg-black/25 text-ink/90"
        }`}
      >
        {pending ? (
          <span className="inline-flex items-center gap-1.5 text-dim">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-aurora-cyan animate-pulse-soft" />
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-aurora-violet animate-pulse-soft" style={{ animationDelay: "0.3s" }} />
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-aurora-teal animate-pulse-soft" style={{ animationDelay: "0.6s" }} />
            thinking
          </span>
        ) : (
          <>
            {children}
            {audioBase64 && <VoiceReplyPlayer audioBase64={audioBase64} audioMime={audioMime} />}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * ChatPanel — grounded Q&A about one episode's document(s).
 * Loads the saved thread on mount; each question is answered server-side
 * strictly from the stored source brief.
 */
export default function ChatPanel({ authToken, episodeId }) {
  const [messages, setMessages] = useState(null); // null = loading
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef(null);

  // Load the saved thread.
  useEffect(() => {
    let isActive = true;
    setMessages(null);
    setError("");
    if (!episodeId) return undefined;
    axios
      .get(`${API_URL}/episodes/${episodeId}/chat`, {
        headers: { Authorization: `Bearer ${authToken}` },
        timeout: 15_000,
      })
      .then(({ data }) => {
        if (isActive) setMessages(data.messages || []);
      })
      .catch(() => {
        if (isActive) setMessages([]);
      });
    return () => {
      isActive = false;
    };
  }, [authToken, episodeId]);

  // Keep the thread scrolled to the newest turn.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, asking]);

  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q || asking || !episodeId) return;
    setAsking(true);
    setError("");
    setQuestion("");
    setMessages((m) => [...(m || []), { role: "user", content: q }]);
    try {
      const { data } = await axios.post(
        `${API_URL}/episodes/${episodeId}/chat`,
        { question: q },
        { headers: { Authorization: `Bearer ${authToken}` }, timeout: 60_000 },
      );
      setMessages((m) => [...(m || []), {
        role: "assistant",
        content: data.answer,
        audio_base64: data.audio_base64,
        audio_mime: data.audio_mime,
      }]);
    } catch (err) {
      const msg = err?.response?.data?.detail || err?.message || "The assistant couldn't answer.";
      setError(msg);
      setMessages((m) => (m || []).filter((t) => t.content !== q)); // roll back the optimistic bubble
      setQuestion(q);
    } finally {
      setAsking(false);
    }
  }, [asking, authToken, episodeId, question]);

  const clearThread = useCallback(async () => {
    if (!episodeId) return;
    try {
      await axios.delete(`${API_URL}/episodes/${episodeId}/chat`, {
        headers: { Authorization: `Bearer ${authToken}` },
        timeout: 15_000,
      });
      setMessages([]);
    } catch {
      /* non-fatal */
    }
  }, [authToken, episodeId]);

  return (
    <section aria-label="Chat with the document" className="glass rounded-[1.75rem] p-5 sm:p-6 flex flex-col">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-display text-lg font-semibold">
            Ask the <span className="text-aurora">document</span>
          </h3>
          <p className="mt-1 text-[11px] text-dim">Answers grounded strictly in what DocuCast read.</p>
        </div>
        {messages && messages.length > 0 && (
          <button
            type="button"
            onClick={clearThread}
            className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] font-semibold text-dim transition-colors hover:text-ink hover:border-white/25"
          >
            Clear
          </button>
        )}
      </div>

      {/* Thread */}
      <div ref={scrollRef} className="panel-scroll mt-4 grid min-h-[14rem] max-h-72 content-start gap-2.5 overflow-y-auto pr-1">
        {messages === null ? (
          <p className="text-xs text-dim animate-pulse-soft">Loading the conversation…</p>
        ) : messages.length === 0 ? (
          <div className="grid gap-2">
            <p className="text-xs text-dim">Start with a question, or tap one:</p>
            {SUGGESTED_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setQuestion(q)}
                className="w-fit rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-[11px] font-semibold text-dim transition-all duration-200 hover:-translate-y-0.5 hover:text-ink hover:border-aurora-violet/50"
              >
                {q}
              </button>
            ))}
          </div>
        ) : (
          messages.map((m, i) => (
            <Bubble key={i} role={m.role} audioBase64={m.audio_base64} audioMime={m.audio_mime}>{m.content}</Bubble>
          ))
        )}
        {asking && <Bubble role="assistant" pending />}
      </div>

      {error && (
        <p role="alert" className="mt-2 rounded-xl border border-red-400/30 bg-red-500/10 px-3.5 py-2 text-[11px] text-red-200">
          {error}
        </p>
      )}

      {/* Ask box */}
      <form
        className="mt-4 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <input
          type="text"
          value={question}
          maxLength={1000}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. What drove the Q2 numbers?"
          aria-label="Ask a question about the document"
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/30 px-3.5 py-2.5 text-xs text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-aurora-cyan/50 focus:border-transparent"
        />
        <button
          type="submit"
          disabled={!question.trim() || asking}
          className="btn-aurora shrink-0 rounded-xl px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {asking ? "…" : "Ask"}
        </button>
      </form>
    </section>
  );
}
