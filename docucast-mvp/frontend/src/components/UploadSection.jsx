import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "/api";
const ACCEPTED_EXTENSIONS = [".pdf", ".pptx", ".docx", ".md", ".markdown", ".txt"];
const MAX_SIZE_MB = 20;
const MAX_FILES = 5;
const LANGUAGE_OPTIONS = [
  ["en", "English", "en-US-JennyNeural", "en-US-GuyNeural"],
  ["es", "Spanish", "es-ES-ElviraNeural", "es-ES-AlvaroNeural"],
  ["fr", "French", "fr-FR-DeniseNeural", "fr-FR-HenriNeural"],
  ["de", "German", "de-DE-KatjaNeural", "de-DE-ConradNeural"],
  ["it", "Italian", "it-IT-ElsaNeural", "it-IT-DiegoNeural"],
  ["pt", "Portuguese", "pt-BR-FranciscaNeural", "pt-BR-AntonioNeural"],
  ["hi", "Hindi", "hi-IN-SwaraNeural", "hi-IN-MadhurNeural"],
  ["ja", "Japanese", "ja-JP-NanamiNeural", "ja-JP-KeitaNeural"],
];

const FILE_META = {
  pdf: { label: "PDF", tint: "text-aurora-magenta", glyph: "◰" },
  pptx: { label: "Slides", tint: "text-aurora-cyan", glyph: "▤" },
  docx: { label: "Word", tint: "text-aurora-indigo", glyph: "▤" },
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

function isYoutubeUrl(url = "") {
  return /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)/i.test(url.trim());
}

export default function UploadSection({
  files,
  setFiles,
  studio,
  setStudio,
  onGenerate,
  loading,
  loadingMessage,
  stageIndex = 0,
  stageCount = 1,
  elapsedSeconds = 0,
  retryAfterSeconds = 0,
  authToken,
}) {
  const inputRef = useRef(null);
  const [sourceMode, setSourceMode] = useState("files"); // "files" | "url" | "batch"
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState("");
  const [showTuning, setShowTuning] = useState(false);
  const [lastAccepted, setLastAccepted] = useState(null);

  // URL state
  const [inputUrl, setInputUrl] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState(null);
  const [previewError, setPreviewError] = useState("");
  const [briefText, setBriefText] = useState("");
  const [excludedLines, setExcludedLines] = useState(new Set());
  const [voiceCatalog, setVoiceCatalog] = useState([]);
  const [pageCount, setPageCount] = useState(0);
  const [pageStart, setPageStart] = useState(1);
  const [pageEnd, setPageEnd] = useState("");
  const [pageSelectionText, setPageSelectionText] = useState("");
  const [pagePreviewLoading, setPagePreviewLoading] = useState(false);
  const [pagePreviewNonce, setPagePreviewNonce] = useState(0);
  const [pagePreviews, setPagePreviews] = useState([]);
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState("");

  // Batch / Playlist state
  const [batchTitle, setBatchTitle] = useState("");
  const [batchDesc, setBatchDesc] = useState("");
  const [batchUrls, setBatchUrls] = useState("");

  useEffect(() => {
    if (!authToken) return undefined;
    axios.get(`${API_URL}/tts/voices`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then(({ data }) => setVoiceCatalog(data.voices || []))
      .catch(() => setVoiceCatalog([]));
    return undefined;
  }, [authToken]);

  useEffect(() => {
    const pdf = files.find((file) => file.name.toLowerCase().endsWith(".pdf"));
    if (!pdf) {
      setPdfPreviewUrl("");
      return undefined;
    }
    const objectUrl = URL.createObjectURL(pdf);
    setPdfPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [files]);

  useEffect(() => {
    if (sourceMode !== "files" || !files.length || loading) return undefined;
    const extract = async () => {
      setPagePreviewLoading(true);
      const data = new FormData();
      files.forEach((file) => data.append("files", file));
      data.append("page_start", String(pageStart));
      if (pageEnd) data.append("page_end", String(pageEnd));
      if (pageSelectionText) data.append("selected_pages", pageSelectionText);
      try {
        const response = await axios.post(`${API_URL}/extract-preview`, data, {
          headers: { Authorization: `Bearer ${authToken}` }, timeout: 30_000,
        });
        setBriefText(response.data.source_text || "");
        setPagePreviews(response.data.stats?.page_previews || []);
        const pages = Number(response.data.stats?.pages || 0);
        if (pages) {
          setPageCount(pages);
          if (!pageEnd) setPageEnd(String(pages));
          if (!pageSelectionText) setPageSelectionText(`1-${pages}`);
        }
        setExcludedLines(new Set());
        setPreviewError("");
      } catch (err) {
        setPreviewError(err?.response?.data?.detail || "Could not extract a preview.");
        setPagePreviews([]);
      } finally {
        setPagePreviewLoading(false);
      }
    };
    extract();
    return undefined;
  }, [authToken, files, loading, pagePreviewNonce, sourceMode]);

  // Text and Markdown can be previewed immediately without waiting for the API.
  useEffect(() => {
    if (sourceMode !== "files" || !files.length || loading) return undefined;
    const textFile = files.find((file) => /\.(txt|text|md|markdown)$/i.test(file.name));
    if (!textFile) return undefined;
    let active = true;
    textFile.text().then((text) => {
      if (active && text.trim()) setBriefText(text.slice(0, 14000));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [files, loading, sourceMode]);

  const acceptFile = useCallback(
    (candidate) => {
      setFileError("");
      if (!candidate) {
        setFiles([]);
        return false;
      }
      const incoming = Array.isArray(candidate) ? candidate : [candidate];
      const accepted = [];
      for (const c of incoming) {
        const ext = "." + extOf(c.name);
        if (c.name.toLowerCase().endsWith(".ppt")) {
          setFileError(`${c.name}: legacy .ppt isn't supported — re-save the deck as .pptx and try again.`);
          continue;
        }
        if (c.name.toLowerCase().endsWith(".doc")) {
          setFileError(`${c.name}: legacy .doc isn't supported — re-save the document as .docx and try again.`);
          continue;
        }
        if (!ACCEPTED_EXTENSIONS.includes(ext)) {
          setFileError(`"${ext}" isn't supported yet. Use ${ACCEPTED_EXTENSIONS.join(", ")}.`);
          continue;
        }
        if (c.size > MAX_SIZE_MB * 1024 * 1024) {
          setFileError(`${c.name} is ${(c.size / (1024 * 1024)).toFixed(1)} MB — the limit is ${MAX_SIZE_MB} MB.`);
          continue;
        }
        if (c.size === 0) {
          setFileError(`${c.name} looks empty.`);
          continue;
        }
        accepted.push(c);
      }
      const maxCount = sourceMode === "batch" ? 15 : MAX_FILES;
      const combined = accepted.slice(0, maxCount);
      if (accepted.length > maxCount) {
        setFileError(`At most ${maxCount} documents — keeping the first ${maxCount}.`);
      }
      if (combined.length) {
        setFiles(combined);
        setLastAccepted(combined[combined.length - 1].name);
        return true;
      }
      if (!fileError) setFileError("No usable file was selected.");
      return false;
    },
    [setFiles, fileError, sourceMode],
  );

  const removeFile = (name) => {
    setFiles((current) => current.filter((f) => f.name !== name));
  };

  const handleChange = (e) => {
    acceptFile(e.target.files ? Array.from(e.target.files) : null);
    e.target.value = "";
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (loading) return;
    acceptFile(e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : null);
  };

  // Preview URL content
  const handlePreviewUrl = async () => {
    const trimmed = inputUrl.trim();
    if (!trimmed || trimmed.length < 5) return;
    setPreviewLoading(true);
    setPreviewError("");
    setPreviewData(null);
    try {
      const { data } = await axios.post(
        `${API_URL}/ingest-preview`,
        { url: trimmed },
        { headers: { Authorization: `Bearer ${authToken}` }, timeout: 20_000 }
      );
      setPreviewData(data);
      setBriefText(data.source_text || "");
      setExcludedLines(new Set());
    } catch (err) {
      setPreviewError(err?.response?.data?.detail || "Could not preview this URL.");
    } finally {
      setPreviewLoading(false);
    }
  };

  // Submission handler
  const handleGenerateClick = () => {
    if (sourceMode === "url") {
      onGenerate({ url: inputUrl.trim(), redactedSource: approvedBrief });
    } else if (sourceMode === "batch") {
      onGenerate({
        batch: true,
        files,
        urls: batchUrls.trim(),
        playlistTitle: batchTitle.trim() || "Untitled Series",
        description: batchDesc.trim(),
      });
    } else {
      onGenerate({ files, redactedSource: approvedBrief, pageStart, pageEnd: pageEnd || undefined, selectedPages: pageSelectionText || undefined });
    }
  };

  const canGenerate =
    !loading &&
    retryAfterSeconds === 0 &&
    (sourceMode === "files"
      ? files.length > 0
      : sourceMode === "url"
      ? inputUrl.trim().length > 6
      : files.length > 0 || batchUrls.trim().length > 6);

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const elapsedLabel = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
  const briefLines = briefText.split("\n");
  const approvedBrief = briefLines.filter((_line, index) => !excludedLines.has(index)).join("\n").trim();

  const updateStudio = (key, value) => setStudio((current) => ({ ...current, [key]: value }));
  const selectedLanguage = LANGUAGE_OPTIONS.find(([code]) => code === studio.language) || LANGUAGE_OPTIONS[0];

  return (
    <section aria-label="Create a podcast" className="glass rounded-[1.75rem] p-5 sm:p-7 shadow-glass">
      {/* Mode Switcher */}
      <div className="flex w-full flex-wrap items-center gap-1.5 rounded-2xl border border-white/10 bg-black/30 p-1 mb-6 sm:w-fit">
        <button
          type="button"
          onClick={() => {
            setSourceMode("files");
            setFileError("");
          }}
          className={`flex-1 rounded-xl px-2 py-2 text-[11px] font-semibold leading-tight transition-all sm:px-4 sm:text-xs ${
            sourceMode === "files"
              ? "bg-aurora-violet/30 border border-aurora-violet/60 text-white shadow-glow"
              : "text-dim hover:text-ink border border-transparent"
          }`}
        >
          📁 Document File
        </button>
        <button
          type="button"
          onClick={() => {
            setSourceMode("url");
            setFileError("");
          }}
          className={`flex-1 rounded-xl px-2 py-2 text-[11px] font-semibold leading-tight transition-all sm:px-4 sm:text-xs ${
            sourceMode === "url"
              ? "bg-aurora-cyan/30 border border-aurora-cyan/60 text-white shadow-glow"
              : "text-dim hover:text-ink border border-transparent"
          }`}
        >
          🔗 Link / YouTube
        </button>
        <button
          type="button"
          onClick={() => {
            setSourceMode("batch");
            setFileError("");
          }}
          className={`flex-1 rounded-xl px-2 py-2 text-[11px] font-semibold leading-tight transition-all sm:px-4 sm:text-xs ${
            sourceMode === "batch"
              ? "bg-aurora-teal/30 border border-aurora-teal/60 text-white shadow-glow"
              : "text-dim hover:text-ink border border-transparent"
          }`}
        >
          📚 Batch Series / Playlist
        </button>
      </div>

      {/* Mode 1: Document Dropzone */}
      {sourceMode === "files" && (
        <>
          <div
            role="button"
            tabIndex={0}
            aria-label={
              files.length
                ? `${files.length} document${files.length > 1 ? "s" : ""} selected. Activate to choose others.`
                : "Choose or drop up to 5 documents"
            }
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
              ${
                dragging
                  ? "border-aurora-cyan/80 bg-aurora-cyan/5 shadow-glow-cyan scale-[1.01]"
                  : "border-white/15 hover:border-aurora-violet/50 hover:bg-white/[0.03]"
              }
              ${loading ? "opacity-50 pointer-events-none" : ""}`}
          >
            {files.length ? (
              <>
                <span className="text-3xl text-aurora-violet animate-pulse-soft" aria-hidden="true">
                  {files.length === 1 ? FILE_META[extOf(files[0].name)]?.glyph || "◰" : "◫"}
                </span>
                <div className="w-full max-w-2xl">
                  <p className="font-display text-base font-semibold text-ink">
                    {files.length === 1 ? files[0].name : `${files.length} sources — one episode`}
                    <span className="ml-2 text-xs font-normal text-dim">
                      {(totalBytes / (1024 * 1024)).toFixed(2)} MB · click or drop to replace
                    </span>
                  </p>
                  <div className="mt-2.5 flex flex-wrap justify-center gap-2">
                    {files.map((f) => {
                      const meta = FILE_META[extOf(f.name)];
                      return (
                        <span
                          key={f.name + f.size}
                          className={`source-chip group/chip ${lastAccepted === f.name ? "source-chip--new" : ""}`}
                          title={`${(f.size / 1024).toFixed(0)} KB`}
                        >
                          <span className={`mr-1 ${meta?.tint || "text-aurora-violet"}`} aria-hidden="true">
                            {meta?.glyph || "◰"}
                          </span>
                          <span className="max-w-[12rem] truncate">{f.name}</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeFile(f.name);
                            }}
                            aria-label={`Remove ${f.name}`}
                            className="ml-1.5 rounded-full px-1 text-dim opacity-60 transition-all hover:text-red-300 hover:opacity-100"
                          >
                            ✕
                          </button>
                        </span>
                      );
                    })}
                  </div>
                  {files.length > 1 && (
                    <p className="mt-2 text-[11px] text-faint">
                      The hosts will compare and connect all {files.length} documents in one episode.
                    </p>
                  )}
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
                    Drop {MAX_FILES > 1 ? "documents" : "a document"}, or <span className="text-aurora">browse</span>
                    {MAX_FILES > 1 && (
                      <span className="ml-2 text-xs font-normal text-dim">up to {MAX_FILES} — mixed & matched</span>
                    )}
                  </p>
                  <p className="mt-1.5 text-xs text-dim">
                    PDF · PPTX · DOCX · Markdown · TXT — up to {MAX_SIZE_MB} MB each
                  </p>
                </div>
              </>
            )}
          </div>

          {sourceMode === "files" && files.length > 0 && pageCount > 0 && (
            <div className="mt-5 rounded-2xl border border-aurora-cyan/25 bg-aurora-cyan/[0.04] p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-widest text-aurora-cyan">Page selection</p>
                  <p className="mt-1 text-xs text-dim">Choose which PDF pages reach the summarizer. Non-PDF files use their full content.</p>
                </div>
                <span className="rounded-full border border-aurora-cyan/30 px-3 py-1 text-[11px] font-semibold text-cyan-200">
                  Pages {pageStart}–{pageEnd || pageCount} of {pageCount}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:max-w-sm">
                <label className="text-[11px] text-dim">From
                  <input type="number" min="1" max={pageCount} value={pageStart} onChange={(e) => { setPageStart(Math.max(1, Math.min(pageCount, Number(e.target.value) || 1))); setBriefText(""); setExcludedLines(new Set()); }} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-ink" />
                </label>
                <label className="text-[11px] text-dim">To
                  <input type="number" min={pageStart} max={pageCount} value={pageEnd || pageCount} onChange={(e) => { setPageEnd(String(Math.max(pageStart, Math.min(pageCount, Number(e.target.value) || pageCount)))); setBriefText(""); setExcludedLines(new Set()); }} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-ink" />
                </label>
              </div>
              <p className="mt-3 text-xs font-semibold text-ink">Selected range: pages {pageStart}–{pageEnd || pageCount}</p>
              <label className="mt-3 block text-[11px] text-dim">Specific pages or mixed ranges
                <input type="text" value={pageSelectionText} onChange={(e) => { setPageSelectionText(e.target.value); setBriefText(""); setExcludedLines(new Set()); }} placeholder="Example: 1,2,8 or 1-2,8" className="mt-1 w-full rounded-lg border border-aurora-cyan/30 bg-black/30 px-3 py-2 text-sm text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-aurora-cyan/50" />
              </label>
              <p className="mt-2 text-xs font-semibold text-ink">Selected pages: {pageSelectionText || `${pageStart}–${pageEnd || pageCount}`}</p>
              <button type="button" disabled={pagePreviewLoading} onClick={() => { setBriefText(""); setExcludedLines(new Set()); setPagePreviewNonce((value) => value + 1); }} className="mt-2 text-xs font-semibold text-aurora-cyan hover:underline disabled:opacity-50">
                {pagePreviewLoading ? "Reading selected pages…" : "Refresh selected-page preview"}
              </button>
            </div>
          )}

          {sourceMode === "files" && pdfPreviewUrl && (
            <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(18rem,0.9fr)]">
              <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/20">
                <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                  <p className="text-xs font-semibold uppercase tracking-widest text-dim">Document preview</p>
                  <span className="text-[11px] text-aurora-cyan">Original page numbers preserved</span>
                </div>
                <iframe
                  title="Uploaded PDF preview"
                  src={`${pdfPreviewUrl}#page=${pageStart}`}
                  className="h-[22rem] w-full bg-white sm:h-[30rem]"
                />
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-widest text-dim">Selected pages</p>
                  <span className="text-[11px] text-dim">{pagePreviews.length} shown</span>
                </div>
                <div className="panel-scroll mt-3 max-h-[26rem] space-y-2 overflow-y-auto pr-1">
                  {pagePreviews.length > 0 ? pagePreviews.map((page) => (
                    <div key={page.page} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                      <div className="flex items-center gap-2">
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-aurora-cyan/30 bg-aurora-cyan/10 text-[11px] font-bold text-cyan-200">{page.page}</span>
                        <span className="text-[11px] font-semibold text-aurora-cyan">Page {page.page}</span>
                      </div>
                      <p className="mt-2 text-xs leading-relaxed text-dim">{page.text || "No selectable text; visual content will be analyzed if available."}</p>
                    </div>
                  )) : (
                    <p className="text-xs leading-relaxed text-dim">Refresh the selected-page preview to load the page representations.</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {sourceMode === "files" && files.length > 0 && briefText && !pdfPreviewUrl && (
            <div className="mt-5 overflow-hidden rounded-2xl border border-aurora-cyan/25 bg-aurora-cyan/[0.04]">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-widest text-aurora-cyan">Live document preview</p>
                  <p className="mt-1 text-[11px] text-dim">Extracted content from {files.length === 1 ? files[0].name : `${files.length} selected sources`}</p>
                </div>
                <span className="rounded-full border border-aurora-cyan/30 px-2.5 py-1 text-[10px] text-cyan-200">Ready to review</span>
              </div>
              <pre className="panel-scroll max-h-[30rem] overflow-y-auto whitespace-pre-wrap px-4 py-4 font-mono text-xs leading-relaxed text-ink/85">{briefText}</pre>
            </div>
          )}

          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".pdf,.pptx,.docx,.md,.markdown,.txt,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain"
            onChange={handleChange}
            className="hidden"
            disabled={loading}
            aria-hidden="true"
            tabIndex={-1}
          />
        </>
      )}

      {/* Mode 2: Link / YouTube Ingestion */}
      {sourceMode === "url" && (
        <div className="rounded-2xl border border-white/10 bg-black/25 p-5 sm:p-6 space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-dim mb-2">
              Article or YouTube URL
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="url"
                value={inputUrl}
                onChange={(e) => {
                  setInputUrl(e.target.value);
                  setPreviewData(null);
                  setBriefText("");
                  setExcludedLines(new Set());
                  setPagePreviews([]);
                  setPreviewError("");
                }}
                placeholder="https://www.youtube.com/watch?v=... or https://example.com/article"
                className="flex-1 rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-aurora-cyan/60"
              />
              <button
                type="button"
                onClick={handlePreviewUrl}
                disabled={previewLoading || inputUrl.trim().length < 6}
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-xs font-semibold text-dim hover:text-ink hover:border-aurora-cyan/50 disabled:opacity-40"
              >
                {previewLoading ? "Inspecting…" : "Preview link"}
              </button>
            </div>
          </div>

          {inputUrl.trim().length > 6 && (
            <div className="flex items-center gap-2">
              {isYoutubeUrl(inputUrl) ? (
                <span className="rounded-full border border-red-400/40 bg-red-500/10 px-3 py-1 text-[11px] font-semibold text-red-200 flex items-center gap-1.5">
                  <span>▶</span> YouTube Video (transcripts will be extracted automatically via yt-dlp)
                </span>
              ) : (
                <span className="rounded-full border border-aurora-cyan/40 bg-aurora-cyan/10 px-3 py-1 text-[11px] font-semibold text-cyan-200 flex items-center gap-1.5">
                  <span>🌐</span> Web Article (content & data tables will be scraped)
                </span>
              )}
            </div>
          )}

          {previewError && (
            <div className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2.5 text-xs text-red-200">
              {previewError}
            </div>
          )}

          {previewData && (
            <div className="rounded-xl border border-aurora-cyan/30 bg-aurora-cyan/5 p-4 text-xs animate-fade-in space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-ink text-sm truncate">{previewData.title}</span>
                <span className="uppercase text-[10px] px-2 py-0.5 rounded-full border border-aurora-cyan/40 text-cyan-200">
                  {previewData.doc_type}
                </span>
              </div>
              <p className="text-dim line-clamp-3 leading-relaxed font-mono text-[11px]">
                {previewData.preview_text}
              </p>
            </div>
          )}
        </div>
      )}

      {briefText && (sourceMode === "files" || previewData) && (
        <div className="mt-5 rounded-2xl border border-amber-300/25 bg-amber-400/[0.04] p-4 sm:p-5 animate-fade-in">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-amber-200">Redaction preview</p>
              <p className="mt-1 text-xs text-dim">Strike any sensitive lines before they reach the script generator.</p>
            </div>
            <span className="shrink-0 rounded-full border border-amber-300/25 px-2.5 py-1 text-[10px] text-amber-100">
              {excludedLines.size} excluded
            </span>
          </div>
          <div className="mt-3 max-h-64 overflow-y-auto rounded-xl border border-white/10 bg-black/30 p-3 space-y-1">
            {briefLines.map((line, index) => {
              const excluded = excludedLines.has(index);
              if (!line.trim()) return <div key={index} className="h-2" />;
              return (
                <button
                  key={`${index}-${line.slice(0, 12)}`}
                  type="button"
                  onClick={() => setExcludedLines((current) => {
                    const next = new Set(current);
                    if (next.has(index)) next.delete(index); else next.add(index);
                    return next;
                  })}
                  className={`block w-full rounded-lg px-2.5 py-1.5 text-left text-[11px] leading-relaxed transition-colors ${excluded ? "bg-red-500/10 text-red-200 line-through" : "text-dim hover:bg-white/[0.05] hover:text-ink"}`}
                  title={excluded ? "Restore this line" : "Exclude this line from generation"}
                >
                  <span className="mr-2 text-[10px] opacity-50">{excluded ? "×" : "·"}</span>{line}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Mode 3: Batch Series & Playlists */}
      {sourceMode === "batch" && (
        <div className="rounded-2xl border border-white/10 bg-black/25 p-5 sm:p-6 space-y-5">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-dim mb-1.5">
              Series / Playlist Title
            </label>
            <input
              type="text"
              value={batchTitle}
              onChange={(e) => setBatchTitle(e.target.value)}
              placeholder="e.g. CS50 Computer Science Lecture Series"
              className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-2.5 text-sm text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-aurora-teal/60"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-dim mb-1.5">
              Description <span className="normal-case font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={batchDesc}
              onChange={(e) => setBatchDesc(e.target.value)}
              placeholder="e.g. Weekly chapters converted into bite-sized conversational episodes"
              className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-2 text-sm text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-aurora-teal/60"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-dim mb-1.5">
              Paste Links <span className="normal-case font-normal">(one YouTube URL or article link per line)</span>
            </label>
            <textarea
              rows={3}
              value={batchUrls}
              onChange={(e) => setBatchUrls(e.target.value)}
              placeholder={"https://www.youtube.com/watch?v=...\nhttps://example.com/lecture-2\nhttps://example.com/lecture-3"}
              className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-2.5 text-xs font-mono text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-aurora-teal/60"
            />
          </div>

          {/* Plus optional document files */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold uppercase tracking-widest text-dim">
                Attach Document Files (optional, up to 15)
              </span>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="text-xs text-aurora-teal hover:underline font-semibold"
              >
                + Add files
              </button>
            </div>
            {files.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {files.map((f) => (
                  <span key={f.name} className="source-chip">
                    <span className="max-w-[10rem] truncate">{f.name}</span>
                    <button
                      type="button"
                      onClick={() => removeFile(f.name)}
                      className="ml-1 text-dim hover:text-red-300"
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
            <input
              ref={inputRef}
              type="file"
              multiple
              accept=".pdf,.pptx,.docx,.md,.markdown,.txt"
              onChange={handleChange}
              className="hidden"
            />
          </div>
        </div>
      )}

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
                          ${
                            active
                              ? "bg-aurora-violet/25 text-white border border-aurora-violet/60 shadow-glow"
                              : "border border-white/10 bg-white/[0.03] text-dim hover:text-ink hover:border-white/25"
                          }`}
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
              <span className="text-[11px] font-semibold uppercase tracking-widest text-faint">Output language</span>
              <select
                value={studio.language || "en"}
                onChange={(e) => {
                  const next = LANGUAGE_OPTIONS.find(([code]) => code === e.target.value) || LANGUAGE_OPTIONS[0];
                  updateStudio("language", next[0]);
                  updateStudio("host_a_voice", next[2]);
                  updateStudio("host_b_voice", next[3]);
                }}
                className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-aurora-cyan/50"
              >
                {LANGUAGE_OPTIONS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
              </select>
              <span className="mt-1 block text-[11px] text-dim">Scripts and fallback voices will use {selectedLanguage[1]}.</span>
            </label>

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
                      onClick={() => setStudio((s) => ({ ...s, focus: active ? "" : preset.text }))}
                      className={`rounded-full px-3 py-1 text-[11px] font-semibold transition-all duration-200 border
                        ${
                          active
                            ? "bg-aurora-cyan/20 text-cyan-200 border-aurora-cyan/50"
                            : "border-white/10 bg-white/[0.03] text-dim hover:text-ink hover:border-white/25"
                        }`}
                    >
                      {active ? "✓ " : "+ "}
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </label>

            <fieldset className="rounded-xl border border-aurora-violet/20 bg-aurora-violet/[0.04] p-4">
              <legend className="px-1 text-[11px] font-semibold uppercase tracking-widest text-aurora-violet">Host voices</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                {[["host_a", "Host A"], ["host_b", "Host B"]].map(([prefix, label]) => (
                  <div key={prefix} className="space-y-2">
                    <input
                      value={studio[`${prefix}_name`]}
                      maxLength={24}
                      onChange={(e) => updateStudio(`${prefix}_name`, e.target.value)}
                      aria-label={`${label} name`}
                      className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-aurora-violet/50"
                      placeholder={label}
                    />
                    <select
                      value={studio[`${prefix}_voice`]}
                      onChange={(e) => updateStudio(`${prefix}_voice`, e.target.value)}
                      aria-label={`${label} voice`}
                      className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-aurora-violet/50"
                    >
                      {[...new Map([
                        { name: selectedLanguage[2], label: `${selectedLanguage[1]} host A` },
                        { name: selectedLanguage[3], label: `${selectedLanguage[1]} host B` },
                        ...voiceCatalog,
                      ].map((voice) => [voice.name, voice])).values()].map((voice) => <option key={voice.name} value={voice.name}>{voice.label}</option>)}
                    </select>
                    <label className="block text-[11px] text-dim">Speed: {studio[`${prefix}_rate`] > 0 ? "+" : ""}{studio[`${prefix}_rate`]}%
                      <input type="range" min="-30" max="50" step="5" value={studio[`${prefix}_rate`]} onChange={(e) => updateStudio(`${prefix}_rate`, Number(e.target.value))} className="mt-1 w-full accent-cyan-400" />
                    </label>
                    <label className="block text-[11px] text-dim">Pitch: {studio[`${prefix}_pitch`] > 0 ? "+" : ""}{studio[`${prefix}_pitch`]}Hz
                      <input type="range" min="-12" max="12" step="2" value={studio[`${prefix}_pitch`]} onChange={(e) => updateStudio(`${prefix}_pitch`, Number(e.target.value))} className="mt-1 w-full accent-violet-400" />
                    </label>
                  </div>
                ))}
              </div>
            </fieldset>
          </div>
        )}
      </div>

      {/* Generate Button */}
      <div className="mt-6 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <button
          type="button"
          onClick={handleGenerateClick}
          disabled={!canGenerate}
          className="btn-aurora flex-1 inline-flex items-center justify-center gap-2.5 rounded-xl px-6 py-4 text-sm font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
        >
          {loading ? (
            <>
              <Spinner />
              {sourceMode === "batch" ? "Generating batch playlist…" : "Producing your episode…"}
            </>
          ) : retryAfterSeconds > 0 ? (
            <>
              <span aria-hidden="true">⏳</span>
              Rate limited — retry in {retryAfterSeconds}s
            </>
          ) : (
            <>
              <span aria-hidden="true">◉</span>
              {sourceMode === "batch"
                ? "Generate batch playlist"
                : sourceMode === "url"
                ? "Generate from URL"
                : "Generate podcast"}
            </>
          )}
        </button>
        {!loading && files.length > 0 && sourceMode === "files" && (
          <button
            type="button"
            onClick={() => setFiles([])}
            className="rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4 text-xs font-semibold text-dim transition-colors hover:text-ink hover:border-white/25"
          >
            Clear
          </button>
        )}
      </div>

      {/* Progress display */}
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
                {sourceMode === "batch"
                  ? "Processing multiple items in queue — synthesizing voices and building playlist."
                  : "Parsing content, writing script, and synthesizing voices."}
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
