import { useCallback, useRef, useState } from "react";

const ACCEPTED_EXTENSIONS = [".pdf", ".pptx", ".md", ".markdown", ".txt"];
const MAX_SIZE_MB = 20;

const FILE_META = {
  pdf: { label: "PDF", tint: "text-aurora-magenta", glyph: "◰" },
  pptx: { label: "Slides", tint: "text-aurora-cyan", glyph: "▤" },
  md: { label: "Markdown", tint: "text-aurora-teal", glyph: "◇" },
  markdown: { label: "Markdown", tint: "text-aurora-teal", glyph: "◇" },
  txt: { label: "Text", tint: "text-aurora-violet", glyph: "≡" },
};

const STUDIO_GROUPS = [
  {
    key: "mode",
    label: "Format",
    options: [
      { value: "dialogue", label: "Two hosts", hint: "Nova & Rhys in conversation" },
      { value: "solo", label: "Solo narrator", hint: "One clean narration" },
    ],
  },
  {
    key: "length",
    label: "Length",
    options: [
      { value: "brief", label: "Brief", hint: "~2 min" },
      { value: "standard", label: "Standard", hint: "~4 min" },
      { value: "deep", label: "Deep dive", hint: "~7 min" },
    ],
  },
  {
    key: "tone",
    label: "Tone",
    options: [
      { value: "conversational", label: "Warm" },
      { value: "energetic", label: "Energetic" },
      { value: "calm", label: "Calm" },
      { value: "expert", label: "Expert" },
    ],
  },
  {
    key: "audience",
    label: "Audience",
    options: [
      { value: "general", label: "Everyone" },
      { value: "student", label: "Students" },
      { value: "expert", label: "Experts" },
      { value: "executive", label: "Executives" },
    ],
  },
];

// One-tap focus presets — clicking sets the text; clicking the active one clears.
const FOCUS_PRESETS = [
  { label: "Key results", text: "spend most time on the key results and what they mean" },
  { label: "Limitations", text: "focus on limitations, caveats and open questions" },
  { label: "Business impact", text: "lead with the business impact and practical takeaways" },
  { label: "Methods & data", text: "walk through the methods and the data behind the claims" },
];

function extOf(name = "") {
  const parts = name.toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() : "";
}

export default function UploadSection({
  file,
  setFile,
  studio,
  setStudio,
  onGenerate,
  loading,
  loadingMessage,
  stageIndex = 0,
  stageCount = 1,
  elapsedSeconds = 0,
  retryAfterSeconds = 0,
}) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState("");
  const [showTuning, setShowTuning] = useState(false);
  const [fileValid, setFileValid] = useState(false);

  const acceptFile = useCallback(
    (candidate) => {
      setFileError("");
      setFileValid(false);
      if (!candidate) {
        setFile(null);
        return false;
      }
      const ext = "." + extOf(candidate.name);
      if (candidate.name.toLowerCase().endsWith(".ppt")) {
        setFileError("Legacy .ppt isn't supported — re-save the deck as .pptx and try again.");
        setFile(null);
        return false;
      }
      if (!ACCEPTED_EXTENSIONS.includes(ext)) {
        setFileError(`"${ext}" isn't supported yet. Use ${ACCEPTED_EXTENSIONS.join(", ")}.`);
        setFile(null);
        return false;
      }
      if (candidate.size > MAX_SIZE_MB * 1024 * 1024) {
        setFileError(`That file is ${(candidate.size / (1024 * 1024)).toFixed(1)} MB — the limit is ${MAX_SIZE_MB} MB.`);
        setFile(null);
        return false;
      }
      if (candidate.size === 0) {
        setFileError("That file looks empty.");
        setFile(null);
        return false;
      }
      setFile(candidate);
      setFileValid(true);
      return true;
    },
    [setFile],
  );

  const handleChange = (e) => {
    acceptFile(e.target.files?.[0] || null);
    e.target.value = "";
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (loading) return;
    acceptFile(e.dataTransfer?.files?.[0] || null);
  };

  const canGenerate = !!file && !loading && retryAfterSeconds === 0;
  const meta = file ? FILE_META[extOf(file.name)] : null;
  const elapsedLabel = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;

  return (
    <section aria-label="Create a podcast" className="glass rounded-[1.75rem] p-5 sm:p-7 shadow-glass">
      {/* Dropzone */}
      <div
        role="button"
        tabIndex={0}
        aria-label={file ? `Selected file ${file.name}. Activate to choose another.` : "Choose or drop a document"}
        onClick={() => !loading && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !loading) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!loading) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={`group relative flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 sm:py-12 text-center transition-all duration-300 cursor-pointer select-none
          ${dragging
            ? "border-aurora-cyan/80 bg-aurora-cyan/5 shadow-glow-cyan scale-[1.01]"
            : "border-white/15 hover:border-aurora-violet/50 hover:bg-white/[0.03]"}
          ${loading ? "opacity-50 pointer-events-none" : ""}`}
      >
        {file ? (
          <>
            <span className={`text-4xl ${meta?.tint || "text-aurora-violet"} ${fileValid ? "animate-pulse" : ""}`} aria-hidden="true">
              {meta?.glyph || "◰"}
              {fileValid && (
                <span className="absolute -right-2 -top-2 w-3 h-3 bg-green-500 rounded-full border-2 border-white/20 animate-pulse" aria-hidden="true" />
              )}
            </span>
            <div>
              <p className="font-display font-semibold text-ink break-all">{file.name}</p>
              <p className="mt-1 text-xs text-dim">
                {meta?.label || "Document"} · {(file.size / (1024 * 1024)).toFixed(2)} MB · click or drop to replace
              </p>
            </div>
          </>
        ) : (
          <>
            <span
              className="text-4xl text-aurora-violet transition-transform duration-300 group-hover:-translate-y-1"
              aria-hidden="true"
            >
              ⇪
            </span>
            <div>
              <p className="font-display text-lg font-semibold text-ink">
                Drop a document, or <span className="text-aurora">browse</span>
              </p>
              <p className="mt-1.5 text-xs text-dim">
                PDF · PPTX · Markdown · TXT — up to {MAX_SIZE_MB} MB
              </p>
            </div>
          </>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.pptx,.md,.markdown,.txt,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/markdown,text/plain"
        onChange={handleChange}
        className="hidden"
        disabled={loading}
        aria-hidden="true"
        tabIndex={-1}
      />

      {fileError && (
        <p role="alert" className="mt-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-2.5 text-xs text-amber-200">
          {fileError}
        </p>
      )}

      {/* Studio controls */}
      <div className="mt-6">
        <button
          type="button"
          onClick={() => setShowTuning((s) => !s)}
          aria-expanded={showTuning}
          aria-controls="studio-panel"
          className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left transition-colors hover:border-aurora-violet/40"
        >
          <span className="text-sm font-semibold text-ink">
            Episode direction
            <span className="ml-2 text-xs font-normal text-dim">
              {studio.mode === "dialogue" ? "two hosts" : "solo"} · {studio.length} · {studio.tone} · {studio.audience}
            </span>
          </span>
          <span className={`text-dim transition-transform duration-300 ${showTuning ? "rotate-180" : ""}`} aria-hidden="true">
            ⌄
          </span>
        </button>

        {showTuning && (
          <div id="studio-panel" className="mt-3 grid gap-4 rounded-xl border border-white/10 bg-black/20 p-4 animate-fade-in">
            {STUDIO_GROUPS.map((group) => (
              <fieldset key={group.key}>
                <legend className="text-[11px] font-semibold uppercase tracking-widest text-faint">{group.label}</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {group.options.map((opt) => {
                    const active = studio[group.key] === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        aria-pressed={active}
                        title={opt.hint}
                        onClick={() => setStudio((s) => ({ ...s, [group.key]: opt.value }))}
                        className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-all duration-200
                          ${active
                            ? "bg-aurora-violet/25 text-white border border-aurora-violet/60 shadow-glow"
                            : "border border-white/10 bg-white/[0.03] text-dim hover:text-ink hover:border-white/25"}`}
                      >
                        {opt.label}
                        {opt.hint && active && <span className="ml-1.5 font-normal opacity-70">{opt.hint}</span>}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ))}

            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-widest text-faint">
                Focus <span className="normal-case font-normal">(optional — steer the episode)</span>
              </span>
              <input
                type="text"
                value={studio.focus}
                maxLength={300}
                onChange={(e) => setStudio((s) => ({ ...s, focus: e.target.value }))}
                placeholder='e.g. "spend most time on the results and limitations"'
                className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-2.5 text-sm text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-aurora-cyan/50 focus:border-transparent"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                {FOCUS_PRESETS.map((preset) => {
                  const active = studio.focus === preset.text;
                  return (
                    <button
                      key={preset.label}
                      type="button"
                      aria-pressed={active}
                      title={active ? "Click again to clear" : preset.text}
                      onClick={() =>
                        setStudio((s) => ({ ...s, focus: active ? "" : preset.text }))
                      }
                      className={`rounded-full px-3 py-1 text-[11px] font-semibold transition-all duration-200 border
                        ${active
                          ? "bg-aurora-cyan/20 text-cyan-200 border-aurora-cyan/50"
                          : "border-white/10 bg-white/[0.03] text-dim hover:text-ink hover:border-white/25"}`}
                    >
                      {active ? "✓ " : "+ "}{preset.label}
                    </button>
                  );
                })}
              </div>
            </label>
          </div>
        )}
      </div>

      {/* Generate */}
      <div className="mt-6 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <button
          type="button"
          onClick={onGenerate}
          disabled={!canGenerate}
          className="btn-aurora flex-1 inline-flex items-center justify-center gap-2.5 rounded-xl px-6 py-4 text-sm font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
        >
          {loading ? (
            <>
              <Spinner />
              Producing your episode…
            </>
          ) : retryAfterSeconds > 0 ? (
            <>
              <span aria-hidden="true">⏳</span>
              Rate limited — retry in {retryAfterSeconds}s
            </>
          ) : (
            <>
              <span aria-hidden="true">◉</span>
              Generate podcast
            </>
          )}
        </button>
        {!loading && file && (
          <button
            type="button"
            onClick={() => setFile(null)}
            className="rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4 text-xs font-semibold text-dim transition-colors hover:text-ink hover:border-white/25"
          >
            Clear
          </button>
        )}
      </div>

      {/* Progress */}
      {loading && (
        <div
          className="mt-5 rounded-xl border border-white/10 bg-black/25 px-5 py-4 animate-fade-in"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-3">
            <span className="flex items-end gap-[3px] h-5" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className="eq-bar h-full" style={{ animationDelay: `${i * 0.13}s` }} />
              ))}
            </span>
            <div className="flex-1">
              <p className="text-sm font-medium text-ink">
                {loadingMessage} <span className="tabular-nums text-dim font-normal">· {elapsedLabel}</span>
              </p>
              <p className="mt-0.5 text-xs text-dim">
                Longer documents and deep dives can take a couple of minutes.
              </p>
            </div>
          </div>
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-gradient-to-r from-aurora-violet via-aurora-indigo to-aurora-cyan transition-all duration-700"
              style={{ width: `${Math.min(92, ((stageIndex + 1) / stageCount) * 100)}%` }}
            />
          </div>
        </div>
      )}
    </section>
  );
}

function Spinner() {
  return (
    <svg className="w-4 h-4 animate-spin-slow" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}
