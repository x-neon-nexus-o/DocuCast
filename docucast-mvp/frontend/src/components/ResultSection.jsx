import { useEffect, useMemo, useRef, useState } from "react";

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
function Player({ src, downloadName, engineLabel }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);

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
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("ended", onEnd);
    };
  }, [src]);

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

  const seek = (e) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const t = (Number(e.target.value) / 100) * duration;
    audio.currentTime = t;
    setCurrent(t);
  };

  const cycleRate = () => {
    const rates = [1, 1.25, 1.5, 2, 0.75];
    const next = rates[(rates.indexOf(rate) + 1) % rates.length];
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const skip = (delta) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(duration || 0, audio.currentTime + delta));
  };

  const handleDownload = () => {
    const link = document.createElement("a");
    link.href = src;
    link.download = downloadName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const progress = duration ? (current / duration) * 100 : 0;

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
          <input
            type="range"
            min="0"
            max="100"
            step="0.1"
            value={progress}
            onChange={seek}
            className="seek mt-2 w-full"
            style={{ "--seek": `${progress}%` }}
            aria-label="Seek through the episode"
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

function IntelligencePanel({ analysis }) {
  const [open, setOpen] = useState("tables");
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
                aria-selected={open === s.id}
                onClick={() => setOpen(open === s.id ? "" : s.id)}
                className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-all duration-200 border
                  ${open === s.id
                    ? "bg-aurora-violet/25 text-white border-aurora-violet/60"
                    : "bg-white/[0.03] text-dim border-white/10 hover:text-ink hover:border-white/25"}`}
              >
                {s.title} <span className="opacity-70">({s.count})</span>
              </button>
            ))}
          </div>
          {sections.map(
            (s) =>
              open === s.id && (
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
/* Result section                                                      */
/* ------------------------------------------------------------------ */
export default function ResultSection({ result, fileName }) {
  const {
    script,
    audio_base64: audioBase64,
    audio_mime: audioMime,
    audio_engine: audioEngine,
    audio_error: audioError,
    audio_note: audioNote,
    provider,
    provider_note: providerNote,
    analysis,
  } = result;

  const [copied, setCopied] = useState(false);

  const audioSrc = useMemo(() => {
    if (!audioBase64) return null;
    return `data:${audioMime || "audio/mpeg"};base64,${audioBase64}`;
  }, [audioBase64, audioMime]);

  const downloadName = useMemo(() => {
    const base = (fileName || result.filename || "document").replace(/\.(pdf|pptx|md|markdown|txt)$/i, "");
    const ext = (audioMime || "").includes("wav") ? "wav" : "mp3";
    return `${base}-docucast.${ext}`;
  }, [audioMime, fileName, result.filename]);

  const { turns, isDialogue } = useMemo(() => parseTranscript(script), [script]);
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

      {/* Player */}
      {audioSrc ? (
        <Player src={audioSrc} downloadName={downloadName} engineLabel={engineLabel} />
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
          <h3 id="transcript-heading" className="font-display text-lg font-semibold">
            Transcript
          </h3>
          <div className="flex items-center gap-2">
            {isDialogue && (
              <span className="hidden sm:flex items-center gap-2 text-[11px] text-dim mr-1">
                <span className="rounded-full border border-aurora-violet/40 bg-aurora-violet/20 px-2.5 py-0.5 font-semibold text-violet-200">Nova</span>
                <span className="rounded-full border border-aurora-cyan/40 bg-aurora-cyan/15 px-2.5 py-0.5 font-semibold text-cyan-200">Rhys</span>
              </span>
            )}
            <button
              type="button"
              onClick={copyTranscript}
              className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 text-xs font-semibold text-dim transition-colors hover:text-ink hover:border-aurora-cyan/50"
            >
              {copied ? "✓ Copied" : "Copy"}
            </button>
          </div>
        </div>

        <div className="script-scroll mt-4 max-h-96 overflow-y-auto pr-2">
          {isDialogue ? (
            <div className="flex flex-col gap-3">
              {turns.map((turn, i) => {
                const style = SPEAKER_STYLES[turn.speaker] || null;
                return (
                  <div key={i} className={`flex gap-3 ${turn.speaker === "RHYS" ? "flex-row-reverse text-right" : ""}`}>
                    {style && (
                      <span
                        className={`mt-0.5 h-fit shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${style.chip}`}
                        aria-label={`${style.name} says`}
                      >
                        {style.name}
                      </span>
                    )}
                    <p className="text-sm leading-relaxed text-ink/90">{turn.text}</p>
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
      <IntelligencePanel analysis={analysis} />
    </div>
  );
}
