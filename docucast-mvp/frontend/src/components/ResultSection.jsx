import { useEffect, useMemo, useRef, useState } from "react";
import ChatPanel from "./ChatPanel.jsx";

const SPEAKER_STYLES = {
  NOVA: { chip: "bg-aurora-violet/20 text-violet-200 border-aurora-violet/40", name: "Nova" },
  RHYS: { chip: "bg-aurora-cyan/15 text-cyan-200 border-aurora-cyan/40", name: "Rhys" },
};

const SPEAKER_LINE = /^\s*(NOVA|RHYS|HOST|GUEST|ALEX|SAM)\s*[:\-–]\s*(.+)$/i;
const ALIASES = { HOST: "NOVA", ALEX: "NOVA", GUEST: "RHYS", SAM: "RHYS" };

function parseTranscript(script) {
  const lines = (script || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const turns = [];
  let sawSpeaker = false;
  for (const line of lines) {
    const m = line.match(SPEAKER_LINE);
    if (m) {
      sawSpeaker = true;
      const raw = m[1].toUpperCase();
      turns.push({ speaker: ALIASES[raw] || raw, text: m[2] });
    } else if (turns.length) {
      turns[turns.length - 1].text += " " + line;
    } else {
      turns.push({ speaker: null, text: line });
    }
  }
  return { turns, isDialogue: sawSpeaker };
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* Custom audio player                                                 */
/* ------------------------------------------------------------------ */
/**
 * Static waveform rendered once from the decoded audio via Web Audio's
 * decodeAudioData, then overlaid with a playhead fill synced to currentTime.
 * Falls back to the plain range input when Web Audio is unavailable.
 */
function WaveformSeek({ audioSrc, duration, current, playing, onSeek }) {
  const canvasRef = useRef(null);
  const [peaks, setPeaks] = useState(null);

  // Decode the audio once per src and compute min/max peaks per bucket.
  useEffect(() => {
    if (!audioSrc) return undefined;
    let isActive = true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return undefined;

    fetch(audioSrc)
      .then((res) => res.arrayBuffer())
      .then((buf) => new AC().decodeAudioData(buf))
      .then((audioBuf) => {
        if (!isActive) return;
        const data = audioBuf.getChannelData(0);
        const BUCKETS = 160;
        const bucketSize = Math.max(1, Math.floor(data.length / BUCKETS));
        const out = [];
        for (let b = 0; b < BUCKETS; b++) {
          let peak = 0;
          const start = b * bucketSize;
          const end = Math.min(start + bucketSize, data.length);
          for (let i = start; i < end; i += 4) { // sample every 4th frame
            const v = Math.abs(data[i]);
            if (v > peak) peak = v;
          }
          out.push(peak);
        }
        const max = Math.max(...out, 0.01);
        setPeaks(out.map((p) => p / max));
      })
      .catch(() => {
        /* keep null → fallback slider */
      });
    return () => {
      isActive = false;
    };
  }, [audioSrc]);

  // Draw on every current-time update.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks) return;
    const ctx = canvas.getContext("2d");
    const w = (canvas.width = canvas.clientWidth * 2); // 2x for crispness
    const h = (canvas.height = canvas.clientHeight * 2);
    const progress = duration ? current / duration : 0;

    ctx.clearRect(0, 0, w, h);
    const barW = w / peaks.length;
    peaks.forEach((p, i) => {
      const barH = Math.max(3, p * (h - 4));
      const x = i * barW;
      const played = i / peaks.length <= progress;
      ctx.fillStyle = played ? "#8b5cf6" : "rgba(154, 162, 192, 0.35)";
      // Gradient on the played head for the aurora feel
      if (played) {
        const grad = ctx.createLinearGradient(0, 0, w, 0);
        grad.addColorStop(0, "#8b5cf6");
        grad.addColorStop(1, "#22d3ee");
        ctx.fillStyle = grad;
      }
      ctx.beginPath();
      const r = Math.min(2, barW / 3);
      const bw = Math.max(1.5, barW * 0.55);
      const y = (h - barH) / 2;
      ctx.roundRect ? ctx.roundRect(x + (barW - bw) / 2, y, bw, barH, r)
                    : ctx.rect(x + (barW - bw) / 2, y, bw, barH);
      ctx.fill();
    });
  }, [peaks, current, duration, playing]);

  const handleClick = (e) => {
    const canvas = canvasRef.current;
    if (!canvas || !duration) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    onSeek(Math.max(0, Math.min(1, ratio)) * duration);
  };

  // Fallback: original range input (also used before peaks decode).
  if (!peaks) {
    const progress = duration ? (current / duration) * 100 : 0;
    return (
      <input
        type="range"
        min="0"
        max="100"
        step="0.1"
        value={progress}
        onChange={(e) => onSeek((Number(e.target.value) / 100) * duration)}
        className="seek mt-2 w-full"
        style={{ "--seek": `${progress}%` }}
        aria-label="Seek through the episode"
      />
    );
  }

  return (
    <canvas
      ref={canvasRef}
      onClick={handleClick}
      role="slider"
      aria-label="Seek through the episode"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration) || 0}
      aria-valuenow={Math.round(current) || 0}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") onSeek(current + 10);
        if (e.key === "ArrowLeft") onSeek(current - 10);
      }}
      className="waveform mt-2 w-full cursor-pointer"
      style={{ height: "44px" }}
    />
  );
}

function Player({ src, downloadName, engineLabel, onTimeUpdate, seekTime, onSeekHandled }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);

  useEffect(() => {
    if (seekTime != null && audioRef.current) {
      audioRef.current.currentTime = seekTime;
      audioRef.current.play().catch(() => {});
      setPlaying(true);
      onSeekHandled?.();
    }
  }, [seekTime, onSeekHandled]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    const onTime = () => {
      setCurrent(audio.currentTime);
      onTimeUpdate?.(audio.currentTime);
    };
    const onMeta = () => setDuration(audio.duration || 0);
    const onEnd = () => setPlaying(false);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    audio.addEventListener("ended", onEnd);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("ended", onEnd);
    };
  }, [src, onTimeUpdate]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio.play();
      setPlaying(true);
    }
  };

  const skip = (delta) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(duration || 0, audio.currentTime + delta));
  };

  const cycleRate = () => {
    const rates = [1, 1.25, 1.5, 2, 0.75];
    const next = rates[(rates.indexOf(rate) + 1) % rates.length];
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const handleDownload = () => {
    const link = document.createElement("a");
    link.href = src;
    link.download = downloadName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="glass-deep rounded-2xl p-5">
      <audio ref={audioRef} src={src} preload="metadata">
        <track kind="captions" />
      </audio>

      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "Pause" : "Play"}
          className="btn-aurora grid h-14 w-14 shrink-0 place-items-center rounded-full text-xl text-white"
        >
          {playing ? "❚❚" : "▶"}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 text-[11px] text-dim">
            <span className="flex items-center gap-2 min-w-0">
              {playing && (
                <span className="flex items-end gap-[2px] h-3 shrink-0" aria-hidden="true">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="eq-bar h-full" style={{ animationDelay: `${i * 0.14}s` }} />
                  ))}
                </span>
              )}
              <span className="truncate">Your episode {engineLabel ? `· ${engineLabel}` : ""}</span>
            </span>
            <span className="tabular-nums shrink-0">
              {formatTime(current)} / {formatTime(duration)}
            </span>
          </div>
          <WaveformSeek
            audioSrc={src}
            duration={duration}
            current={current}
            playing={playing}
            onSeek={(t) => {
              const audio = audioRef.current;
              if (!audio) return;
              audio.currentTime = Math.max(0, Math.min(duration || 0, t));
              setCurrent(audio.currentTime);
            }}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => skip(-10)} className="chip-btn" aria-label="Back 10 seconds">
          ↺ 10s
        </button>
        <button type="button" onClick={() => skip(10)} className="chip-btn" aria-label="Forward 10 seconds">
          10s ↻
        </button>
        <button type="button" onClick={cycleRate} className="chip-btn" aria-label={`Playback speed ${rate}x`}>
          {rate}×
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={handleDownload}
          className="rounded-full border border-aurora-violet/50 bg-aurora-violet/10 px-4 py-1.5 text-xs font-semibold text-violet-200 transition-colors hover:bg-aurora-violet/25"
        >
          ⇩ Download audio
        </button>
      </div>

      <style>{`
        .chip-btn {
          border-radius: 9999px;
          border: 1px solid rgba(255,255,255,0.1);
          background: rgba(255,255,255,0.04);
          padding: 0.375rem 0.9rem;
          font-size: 0.72rem;
          font-weight: 600;
          color: #9aa2c0;
          transition: color .2s, border-color .2s, transform .15s;
        }
        .chip-btn:hover { color: #e7e9f5; border-color: rgba(139,92,246,0.5); transform: translateY(-1px); }
      `}</style>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Document intelligence panel                                         */
/* ------------------------------------------------------------------ */
function CountPill({ label, count, tint }) {
  if (!count) return null;
  return (
    <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${tint}`}>
      {count} {label}
    </span>
  );
}

function IntelligencePanel({ analysis, openSection, onSectionChange }) {
  if (!analysis) return null;

  const sections = [
    {
      id: "tables",
      title: "Tables",
      count: analysis.tables?.length || 0,
      render: () => (
        <div className="grid gap-3">
          {analysis.tables.map((t, i) => (
            <div key={i} className="rounded-xl border border-white/10 bg-black/25 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-faint">
                Page {t.page} · {t.row_count} rows
              </p>
              <div className="panel-scroll mt-2 overflow-x-auto">
                <MarkdownTable markdown={t.markdown} />
              </div>
              <p className="mt-3 text-xs text-dim leading-relaxed">
                <span className="text-aurora-cyan font-semibold">Narrated as:</span> {t.narration}
              </p>
            </div>
          ))}
        </div>
      ),
    },
    {
      id: "charts",
      title: "Graphs & charts",
      count: (analysis.charts?.length || 0) + (analysis.figures?.length || 0),
      render: () => (
        <div className="grid gap-2.5">
          {analysis.charts?.map((c, i) => (
            <div key={`c${i}`} className="rounded-xl border border-white/10 bg-black/25 p-4">
              <p className="text-xs font-semibold text-aurora-teal">
                {c.chart_type || "Chart"} · slide {c.page} {c.title ? `· "${c.title}"` : ""}
              </p>
              <p className="mt-1.5 text-sm text-ink/90 leading-relaxed">{c.narration}</p>
            </div>
          ))}
          {analysis.figures?.map((f, i) => (
            <div key={`f${i}`} className="rounded-xl border border-white/10 bg-black/25 px-4 py-3">
              <p className="text-sm text-ink/90">
                <span className="text-faint text-xs mr-2">p.{f.page}</span>
                {f.caption}
              </p>
            </div>
          ))}
        </div>
      ),
    },
    {
      id: "images",
      title: "Images",
      count: analysis.images?.length || 0,
      render: () => (
        <div className="grid gap-2.5">
          {analysis.images.map((img, i) => (
            <div key={i} className="rounded-xl border border-white/10 bg-black/25 p-4">
              <p className="text-xs font-semibold text-aurora-magenta">
                {img.kind || "image"} · page {img.page}
                {img.width ? ` · ${img.width}×${img.height}px` : ""}
              </p>
              {img.description && <p className="mt-1.5 text-sm text-ink/90 leading-relaxed">{img.description}</p>}
              {img.ocr_text && (
                <p className="mt-2 text-xs text-dim leading-relaxed">
                  <span className="text-aurora-cyan font-semibold">Text read from image:</span> “{img.ocr_text}”
                </p>
              )}
            </div>
          ))}
        </div>
      ),
    },
    {
      id: "handwriting",
      title: "Handwritten notes",
      count: analysis.handwritten_notes?.length || 0,
      render: () => (
        <div className="grid gap-2.5">
          {analysis.handwritten_notes.map((n, i) => (
            <div key={i} className="rounded-xl border border-amber-300/20 bg-amber-400/5 p-4">
              <p className="text-xs font-semibold text-amber-200">✎ page {n.page} · {n.source}</p>
              <p className="mt-1.5 text-sm text-ink/90 italic leading-relaxed">“{n.text}”</p>
            </div>
          ))}
        </div>
      ),
    },
    {
      id: "notes",
      title: "Speaker notes",
      count: analysis.speaker_notes?.length || 0,
      render: () => (
        <div className="grid gap-2.5">
          {analysis.speaker_notes.map((n, i) => (
            <div key={i} className="rounded-xl border border-white/10 bg-black/25 px-4 py-3">
              <p className="text-xs font-semibold text-faint">slide {n.page}</p>
              <p className="mt-1 text-sm text-ink/90 leading-relaxed">{n.text}</p>
            </div>
          ))}
        </div>
      ),
    },
  ].filter((s) => s.count > 0);

  const stats = analysis.stats || {};

  return (
    <section aria-labelledby="intel-heading" className="glass rounded-[1.75rem] p-5 sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="intel-heading" className="font-display text-lg font-semibold">
          What DocuCast <span className="text-aurora">actually read</span>
        </h3>
        <div className="flex flex-wrap gap-2">
          <CountPill label="pages" count={stats.pages} tint="border-white/15 text-dim" />
          <CountPill label="words" count={stats.words} tint="border-white/15 text-dim" />
        </div>
      </div>

      {analysis.warnings?.length > 0 && (
        <div className="mt-4 grid gap-2">
          {analysis.warnings.map((w, i) => (
            <p key={i} className="rounded-xl border border-amber-300/20 bg-amber-400/5 px-4 py-2.5 text-xs text-amber-200/90">
              {w}
            </p>
          ))}
        </div>
      )}

      {sections.length === 0 ? (
        <p className="mt-4 text-sm text-dim">
          Body text only — no tables, charts, images or notes were detected in this document.
        </p>
      ) : (
        <>
          <div className="mt-5 flex flex-wrap gap-2" role="tablist" aria-label="Extracted content types">
            {sections.map((s) => (
              <button
                key={s.id}
                role="tab"
                aria-selected={openSection === s.id}
                onClick={() => onSectionChange(openSection === s.id ? "" : s.id)}
                className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-all duration-200 border
                  ${openSection === s.id
                    ? "bg-aurora-violet/25 text-white border-aurora-violet/60"
                    : "bg-white/[0.03] text-dim border-white/10 hover:text-ink hover:border-white/25"}`}
              >
                {s.title} <span className="opacity-70">({s.count})</span>
              </button>
            ))}
          </div>
          {openSection && sections.map(
            (s) =>
              openSection === s.id && (
                <div key={s.id} role="tabpanel" className="panel-scroll mt-4 max-h-96 overflow-y-auto pr-1 animate-fade-in">
                  {s.render()}
                </div>
              ),
          )}
        </>
      )}
    </section>
  );
}

function MarkdownTable({ markdown }) {
  const rows = useMemo(
    () =>
      (markdown || "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("|"))
        .map((l) => l.slice(1, -1).split("|").map((c) => c.trim()))
        .filter((cells) => !cells.every((c) => /^-{2,}$/.test(c))),
    [markdown],
  );
  if (!rows.length) return null;
  const [header, ...body] = rows;
  return (
    <table className="w-full min-w-max border-collapse text-left text-xs">
      <thead>
        <tr>
          {header.map((h, i) => (
            <th key={i} className="border-b border-white/15 px-3 py-2 font-semibold text-aurora-cyan whitespace-nowrap">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((r, i) => (
          <tr key={i} className="odd:bg-white/[0.02]">
            {r.map((c, j) => (
              <td key={j} className="border-b border-white/5 px-3 py-1.5 text-ink/85">
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------ */
/* Show notes + chapters (podcast-ready metadata)                      */
/* ------------------------------------------------------------------ */
function ShowNotesCard({ notes, onCopy, copied }) {
  const hasChapters = notes.chapters?.length > 0;
  return (
    <section aria-label="Show notes" className="glass rounded-[1.75rem] p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-aurora-cyan">Show notes</p>
          {notes.title && <h3 className="mt-2 font-display text-2xl font-bold leading-tight">{notes.title}</h3>}
          {notes.description && <p className="mt-1.5 max-w-2xl text-sm text-dim leading-relaxed">{notes.description}</p>}
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="shrink-0 rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 text-xs font-semibold text-dim transition-colors hover:text-ink hover:border-aurora-violet/50"
        >
          {copied ? "✓ Copied" : "Copy as markdown"}
        </button>
      </div>

      {notes.takeaways?.length > 0 && (
        <div className="mt-5">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-faint">Key takeaways</p>
          <ul className="mt-2.5 grid gap-2">
            {notes.takeaways.map((t, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm text-ink/90 leading-relaxed">
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border border-aurora-violet/40 bg-aurora-violet/10 text-[10px] font-bold text-violet-200" aria-hidden="true">
                  {i + 1}
                </span>
                {t}
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasChapters && (
        <div className="mt-6">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-faint">Chapters</p>
          <ol className="mt-2.5 grid gap-2">
            {notes.chapters.map((c, i) => (
              <li key={i} className="flex items-start gap-3 rounded-xl border border-white/10 bg-black/25 px-4 py-3 transition-colors hover:border-aurora-violet/40">
                <span className="tabular-nums text-xs font-bold text-aurora-cyan pt-0.5" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <p className="text-sm font-semibold text-ink">{c.title}</p>
                  {c.summary && <p className="mt-0.5 text-xs text-dim leading-relaxed">{c.summary}</p>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function CitationLegend({ citations }) {
  if (!citations?.length) return null;
  return (
    <section aria-label="Source citations" className="glass rounded-[1.75rem] p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-aurora-teal">Grounding trail</p>
          <h3 className="mt-1 font-display text-lg font-semibold">Sources used by the episode</h3>
        </div>
        <span className="text-[11px] text-dim">Markers appear as [S1], [S2]…</span>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {citations.map((citation) => (
          <div key={citation.id} className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs">
            <span className="font-mono font-bold text-aurora-cyan">[{citation.id}]</span>
            <span className="ml-2 font-semibold text-ink">{citation.label}</span>
            <span className="ml-1 text-dim">· {citation.location}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Result section                                                      */
/* ------------------------------------------------------------------ */
export default function ResultSection({ result, fileName, onRegenerate, onResynthesize, regenerating, authToken }) {
  const {
    script,
    audio_base64: audioBase64,
    audio_url: audioUrl,
    audio_mime: audioMime,
    audio_engine: audioEngine,
    audio_error: audioError,
    audio_note: audioNote,
    transcript_segments: transcriptSegments,
    provider,
    provider_note: providerNote,
    analysis,
    episode_id: episodeId,
    show_notes: showNotes,
  } = result;
  const citations = analysis?.citations || [];
  const displayNames = {
    NOVA: result.options?.host_a_name || "Nova",
    RHYS: result.options?.host_b_name || "Rhys",
  };

  const [copied, setCopied] = useState(false);
  const [notesCopied, setNotesCopied] = useState(false);
  const [openSection, setOpenSection] = useState("");
  const [showEditor, setShowEditor] = useState(false);
  const [editedScript, setEditedScript] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [seekTime, setSeekTime] = useState(null);
  const [autoFollow, setAutoFollow] = useState(true);
  const [personalNote, setPersonalNote] = useState(() => {
    try { return localStorage.getItem(`docucast_note_${result.episode_id || result.filename}`) || ""; } catch { return ""; }
  });
  const [bookmarks, setBookmarks] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`docucast_bookmarks_${result.episode_id || result.filename}`) || "[]"); } catch { return []; }
  });
  const [showStudyCards, setShowStudyCards] = useState(false);
  const [revealedCard, setRevealedCard] = useState(-1);
  const turnRefs = useRef([]);

  useEffect(() => {
    try { localStorage.setItem(`docucast_note_${result.episode_id || result.filename}`, personalNote); } catch { /* storage unavailable */ }
  }, [personalNote, result.episode_id, result.filename]);

  useEffect(() => {
    try { localStorage.setItem(`docucast_bookmarks_${result.episode_id || result.filename}`, JSON.stringify(bookmarks)); } catch { /* storage unavailable */ }
  }, [bookmarks, result.episode_id, result.filename]);

  // Seed the editor with the current script each time it's opened.
  useEffect(() => {
    if (showEditor) setEditedScript(script);
  }, [showEditor, script]);

  const audioSrc = useMemo(() => {
    if (audioUrl) return audioUrl;
    if (!audioBase64) return null;
    return `data:${audioMime || "audio/mpeg"};base64,${audioBase64}`;
  }, [audioBase64, audioMime, audioUrl]);

  const downloadName = useMemo(() => {
    const base = (fileName || result.filename || "document").replace(/\.(pdf|pptx|md|markdown|txt)$/i, "");
    const ext = (audioMime || "").includes("wav") ? "wav" : "mp3";
    return `${base}-docucast.${ext}`;
  }, [audioMime, fileName, result.filename]);

  const { turns: parsedTurns, isDialogue } = useMemo(() => parseTranscript(script), [script]);
  const turns = useMemo(() => {
    if (transcriptSegments && transcriptSegments.length > 0) {
      return transcriptSegments;
    }
    return parsedTurns;
  }, [transcriptSegments, parsedTurns]);

  const activeTurnIndex = useMemo(() => {
    if (!turns.length) return -1;
    return turns.findIndex(
      (t) => t.start != null && currentTime >= t.start && currentTime < (t.end != null ? t.end : t.start + 3.5),
    );
  }, [turns, currentTime]);

  useEffect(() => {
    if (autoFollow && activeTurnIndex >= 0 && turnRefs.current[activeTurnIndex]) {
      turnRefs.current[activeTurnIndex].scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [activeTurnIndex, autoFollow]);

  const wordCount = useMemo(() => (script || "").trim().split(/\s+/).length, [script]);

  const engineLabel =
    audioEngine === "edge-tts" ? "neural voices"
    : audioEngine === "gtts" ? "cloud voices"
    : audioEngine === "piper" ? "offline neural voices"
    : audioEngine === "espeak-ng" ? "offline voices"
    : null;

  const copyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(script);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  const handleDownloadTranscript = () => {
    const blob = new Blob([script], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(fileName || result.filename || 'document').replace(/\.(pdf|pptx|md|markdown|txt)$/i, '')}-transcript.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  };

  const addBookmark = (turn) => {
    if (turn?.start == null) return;
    setBookmarks((current) => current.some((item) => item.start === turn.start)
      ? current
      : [...current, { start: turn.start, text: turn.text, speaker: turn.speaker }].sort((a, b) => a.start - b.start));
  };

  const studyCards = useMemo(() => [
    ...(showNotes?.takeaways || []).map((text) => ({ question: "What is an important takeaway?", answer: text })),
    ...(showNotes?.chapters || []).map((chapter) => ({ question: `What is covered in “${chapter.title}”?`, answer: chapter.summary || chapter.title })),
  ].slice(0, 12), [showNotes]);

  // Regenerate: re-run the LLM on the SAME document with new studio settings.
  const canRegenerate = !!episodeId && !!onRegenerate && !regenerating;
  // Resynthesize: re-run TTS on an edited script (no LLM call needed).
  const canResynthesize = !!onResynthesize && !regenerating;
  const scriptDirty = showEditor && editedScript.trim() !== script.trim();

  // Podcast-platform markdown for the notes card.
  const copyShowNotes = async () => {
    if (!showNotes) return;
    const md = [
      showNotes.title ? `# ${showNotes.title}` : "",
      showNotes.description || "",
      showNotes.takeaways?.length ? "\n## Key takeaways\n" + showNotes.takeaways.map((t) => `- ${t}`).join("\n") : "",
      showNotes.chapters?.length ? "\n## Chapters\n" + showNotes.chapters.map((c, i) => `${i + 1}. ${c.title} — ${c.summary || ""}`).join("\n") : "",
    ].filter(Boolean).join("\n");
    try {
      await navigator.clipboard.writeText(md);
      setNotesCopied(true);
      setTimeout(() => setNotesCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="flex flex-col gap-6 animate-fade-up">
      {/* Header row */}
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="font-display text-giant font-semibold flex-1 min-w-[12rem]">
          Your <span className="text-aurora">episode</span>
        </h2>
        {provider && (
          <span
            className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${
              provider === "local"
                ? "border-amber-300/40 bg-amber-400/10 text-amber-200"
                : "border-aurora-teal/40 bg-aurora-teal/10 text-teal-200"
            }`}
          >
            {provider === "local" ? "⚡ local engine · unlimited" : `✦ ${provider}`}
          </span>
        )}
        <span className="rounded-full border border-white/15 px-3 py-1 text-[11px] font-semibold text-dim">
          {wordCount} words
        </span>
      </div>

      {(providerNote || audioNote) && (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-dim leading-relaxed">
          {providerNote && <p>{providerNote}</p>}
          {audioNote && <p className={providerNote ? "mt-1.5" : ""}>{audioNote}</p>}
        </div>
      )}

      {/* Show notes + chapters */}
      {showNotes && (showNotes.title || showNotes.takeaways?.length || showNotes.chapters?.length) && (
        <ShowNotesCard notes={showNotes} onCopy={copyShowNotes} copied={notesCopied} />
      )}
      <CitationLegend citations={citations} />

      <section aria-label="Personal episode notes" className="glass rounded-[1.75rem] p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-aurora-cyan">Your notebook</p>
            <h3 className="mt-1 font-display text-lg font-semibold">Keep a thought beside this episode</h3>
          </div>
          <span className="text-[11px] text-dim">Saved in this browser</span>
        </div>
        <textarea
          value={personalNote}
          onChange={(event) => setPersonalNote(event.target.value)}
          rows={3}
          placeholder="Add a question, takeaway, or follow-up…"
          className="mt-4 w-full resize-y rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm leading-relaxed text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-aurora-cyan/50"
        />
      </section>

      {bookmarks.length > 0 && (
        <section aria-label="Audio bookmarks" className="glass rounded-[1.75rem] p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-aurora-violet">Listening trail</p>
              <h3 className="mt-1 font-display text-lg font-semibold">Audio bookmarks</h3>
            </div>
            <button type="button" onClick={() => setBookmarks([])} className="text-xs text-dim hover:text-ink">Clear all</button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {bookmarks.map((bookmark) => (
              <button
                key={bookmark.start}
                type="button"
                onClick={() => setSeekTime(bookmark.start)}
                className="rounded-xl border border-aurora-violet/30 bg-aurora-violet/10 px-3 py-2 text-left text-xs text-ink hover:border-aurora-violet/60"
              >
                <span className="font-mono text-aurora-violet">{formatTime(bookmark.start)}</span>
                <span className="ml-2 line-clamp-1">{bookmark.text}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {studyCards.length > 0 && (
        <section aria-label="Study cards" className="glass rounded-[1.75rem] p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-aurora-teal">Review mode</p>
              <h3 className="mt-1 font-display text-lg font-semibold">Study cards</h3>
            </div>
            <button type="button" onClick={() => { setShowStudyCards((value) => !value); setRevealedCard(-1); }} className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 text-xs font-semibold text-dim hover:text-ink hover:border-aurora-teal/50">
              {showStudyCards ? "Hide cards" : `${studyCards.length} cards`}
            </button>
          </div>
          {showStudyCards && (
            <div className="mt-4 grid gap-2.5">
              {studyCards.map((card, index) => (
                <button key={index} type="button" onClick={() => setRevealedCard(revealedCard === index ? -1 : index)} className="rounded-xl border border-white/10 bg-black/20 p-4 text-left hover:border-aurora-teal/50">
                  <p className="text-sm font-semibold text-ink">{card.question}</p>
                  <p className="mt-2 text-xs leading-relaxed text-dim">{revealedCard === index ? card.answer : "Click to reveal answer"}</p>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Studio actions — tune & re-run without re-uploading (NotebookLM feel) */}
      <div className="glass rounded-[1.75rem] p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-base font-semibold">
              Tune this <span className="text-aurora">episode</span>
            </h3>
            <p className="mt-1 text-xs text-dim">
              {episodeId
                ? "Change the format or tone — the same document regenerates instantly, no re-upload."
                : "Open an episode from your library to unlock regeneration."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowEditor((s) => !s)}
              disabled={regenerating}
              aria-expanded={showEditor}
              className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 text-xs font-semibold text-dim transition-colors hover:text-ink hover:border-aurora-cyan/50 disabled:opacity-50"
            >
              {showEditor ? "Close editor" : "✎ Edit script"}
            </button>
            {canRegenerate && (
              <button
                type="button"
                onClick={onRegenerate}
                disabled={regenerating}
                className="btn-aurora rounded-full px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              >
                {regenerating ? "Regenerating…" : "↻ Regenerate"}
              </button>
            )}
          </div>
        </div>
        {regenerating && (
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-gradient-to-r from-aurora-violet via-aurora-indigo to-aurora-cyan animate-pulse-soft" style={{ width: "60%" }} />
          </div>
        )}
      </div>

      {/* Script editor — edit, then re-synthesize audio from the edited text */}
      {showEditor && (
        <section aria-label="Script editor" className="glass rounded-[1.75rem] p-5 sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display text-lg font-semibold">
              Edit <span className="text-aurora">script</span>
            </h3>
            <p className="text-[11px] text-dim">
              Keep the "NOVA:" / "RHYS:" prefixes for distinct voices · edits re-synthesize audio, not the AI
            </p>
          </div>
          <textarea
            value={editedScript}
            onChange={(e) => setEditedScript(e.target.value)}
            rows={12}
            spellCheck={false}
            className="script-scroll mt-4 w-full resize-y rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm leading-relaxed text-ink/90 focus:outline-none focus:ring-2 focus:ring-aurora-cyan/50 focus:border-transparent"
            placeholder="NOVA: …\nRHYS: …"
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-dim">
              {editedScript.trim() ? editedScript.trim().split(/\s+/).length : 0} words
              {scriptDirty ? " · unsaved changes" : ""}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setEditedScript(script)}
                className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 text-xs font-semibold text-dim transition-colors hover:text-ink hover:border-white/25"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={() => onResynthesize(editedScript)}
                disabled={!canResynthesize || !editedScript.trim()}
                className="btn-aurora rounded-full px-5 py-1.5 text-xs font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {regenerating ? "Synthesizing…" : "⇴ Re-synthesize audio"}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Player */}
      {audioSrc ? (
        <Player
          src={audioSrc}
          downloadName={downloadName}
          engineLabel={engineLabel}
          onTimeUpdate={setCurrentTime}
          seekTime={seekTime}
          onSeekHandled={() => setSeekTime(null)}
        />
      ) : (
        <div className="rounded-2xl border border-amber-300/30 bg-amber-400/10 px-5 py-4 text-sm text-amber-100">
          <p className="font-semibold">Audio unavailable</p>
          <p className="mt-1 text-amber-100/80 text-xs leading-relaxed">
            {audioError || "The script was generated, but audio synthesis failed. You can still read the transcript below."}
          </p>
        </div>
      )}

      {/* Transcript */}
      <section aria-labelledby="transcript-heading" className="glass rounded-[1.75rem] p-5 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 id="transcript-heading" className="font-display text-lg font-semibold">
              Interactive Transcript
            </h3>
            <p className="text-[11px] text-dim mt-0.5">
              Click any turn or timestamp to jump audio · auto-follows live playback
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAutoFollow((a) => !a)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                autoFollow
                  ? "border-aurora-teal/50 bg-aurora-teal/15 text-teal-200"
                  : "border-white/10 bg-white/[0.03] text-dim hover:text-ink"
              }`}
              title="Toggle automatic scrolling as audio plays"
            >
              {autoFollow ? "✦ Auto-follow ON" : "✧ Auto-follow OFF"}
            </button>
            {isDialogue && (
              <span className="hidden sm:flex items-center gap-2 text-[11px] text-dim mr-1">
                <span className="rounded-full border border-aurora-violet/40 bg-aurora-violet/20 px-2.5 py-0.5 font-semibold text-violet-200">Nova</span>
                <span className="rounded-full border border-aurora-cyan/40 bg-aurora-cyan/15 px-2.5 py-0.5 font-semibold text-cyan-200">Rhys</span>
              </span>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={copyTranscript}
                className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 text-xs font-semibold text-dim transition-colors hover:text-ink hover:border-aurora-cyan/50"
              >
                {copied ? "✓ Copied" : "Copy"}
              </button>
              <button
                type="button"
                onClick={handleDownloadTranscript}
                className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 text-xs font-semibold text-dim transition-colors hover:text-ink hover:border-aurora-cyan/50"
              >
                📄 Download
              </button>
            </div>
          </div>
        </div>

        {/* Intelligence Preview Bar */}
        {analysis && (
          <div className="flex items-center gap-4 px-4 my-3 bg-white/[0.02] rounded-xl cursor-pointer hover:bg-white/[0.03] transition-colors"
             onClick={() => {
               // Determine first available section to open
               let firstSection = "";
               if (analysis.tables?.length > 0) firstSection = "tables";
               else if ((analysis.charts?.length || 0) + (analysis.figures?.length || 0) > 0) firstSection = "charts";
               else if (analysis.images?.length > 0) firstSection = "images";
               else if (analysis.handwritten_notes?.length > 0) firstSection = "handwriting";
               else if (analysis.speaker_notes?.length > 0) firstSection = "notes";
               
               // Toggle: if closed, open first section; if open, close
               setOpenSection(openSection === "" ? firstSection : "");
             }}
             title="Click to view extracted content"
          >
            <span className="text-xs font-semibold text-dim">Extracted:</span>
            <span className="flex items-center gap-2">
              {analysis.tables?.length > 0 && (
                <>
                  <span className="text-aurora-cyan">📊 {analysis.tables.length}</span>
                  <span className="text-[10px] text-dim">tables</span>
                </>
              )}
              {(analysis.charts?.length || 0) + (analysis.figures?.length || 0) > 0 && (
                <>
                  <span className="text-aurora-teal">📈 {((analysis.charts?.length || 0) + (analysis.figures?.length || 0))}</span>
                  <span className="text-[10px] text-dim">charts</span>
                </>
              )}
              {analysis.images?.length > 0 && (
                <>
                  <span className="text-aurora-magenta">🖼️ {analysis.images.length}</span>
                  <span className="text-[10px] text-dim">images</span>
                </>
              )}
              {analysis.handwritten_notes?.length > 0 && (
                <>
                  <span className="text-amber-200">✎ {analysis.handwritten_notes.length}</span>
                  <span className="text-[10px] text-dim">handwritten</span>
                </>
              )}
              {analysis.speaker_notes?.length > 0 && (
                <>
                  <span className="text-faint">📝 {analysis.speaker_notes.length}</span>
                  <span className="text-[10px] text-dim">notes</span>
                </>
              )}
            </span>
          </div>
        )}

        <div className="script-scroll mt-4 max-h-[28rem] overflow-y-auto pr-2 space-y-2">
          {turns && turns.length > 0 ? (
            <div className="flex flex-col gap-2.5">
              {turns.map((turn, i) => {
                const style = SPEAKER_STYLES[turn.speaker] || null;
                const isActive = i === activeTurnIndex;
                const hasTime = turn.start != null;
                return (
                  <div
                    key={i}
                    ref={(el) => (turnRefs.current[i] = el)}
                    onClick={() => {
                      if (hasTime) setSeekTime(turn.start);
                    }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && hasTime) setSeekTime(turn.start);
                    }}
                    className={`group relative rounded-xl p-3 sm:p-3.5 transition-all duration-300 text-left cursor-pointer border ${
                      isActive
                        ? "bg-aurora-violet/25 border-aurora-violet/60 shadow-glow"
                        : "border-white/5 bg-white/[0.015] hover:bg-white/[0.05] hover:border-white/20"
                    } ${turn.speaker === "RHYS" ? "ml-auto max-w-[90%]" : "mr-auto max-w-[90%]"}`}
                  >
                    <div className="flex items-center justify-between gap-3 mb-1.5">
                      <div className="flex items-center gap-2">
                        {style && (
                          <span
                            className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${style.chip}`}
                          >
                            {displayNames[turn.speaker] || style.name}
                          </span>
                        )}
                        {hasTime && (
                          <span
                            className={`font-mono text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                              isActive
                                ? "bg-aurora-cyan/30 border-aurora-cyan/50 text-cyan-100 font-bold"
                                : "bg-white/5 border-white/10 text-dim group-hover:text-ink group-hover:border-aurora-violet/40"
                            }`}
                          >
                            {isActive ? "▶ " : ""}{formatTime(turn.start)}
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] font-semibold text-dim opacity-0 group-hover:opacity-100 transition-opacity">
                        jump to audio ⇗
                      </span>
                      {hasTime && (
                        <button
                          type="button"
                          onClick={(event) => { event.stopPropagation(); addBookmark(turn); }}
                          className="text-[10px] text-dim hover:text-aurora-violet"
                          title="Bookmark this moment"
                        >
                          ☆
                        </button>
                      )}
                    </div>
                    <p className={`text-sm leading-relaxed transition-colors ${isActive ? "text-white font-medium" : "text-ink/90"}`}>
                      {turn.text}
                    </p>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink/90">{script}</p>
          )}
        </div>
      </section>

      {/* Intelligence */}
      {openSection && (
        <IntelligencePanel
          analysis={analysis}
          openSection={openSection}
          onSectionChange={setOpenSection}
        />
      )}

      {/* Chat with the document */}
      {episodeId && authToken && (
        <ChatPanel authToken={authToken} episodeId={episodeId} />
      )}
    </div>
  );
}
