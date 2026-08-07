import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import UploadSection from "./components/UploadSection.jsx";
import ResultSection from "./components/ResultSection.jsx";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

// Cycled loading messages. The backend runs synchronously in one request, so
// these are a timed UI sequence, NOT real server progress.
const LOADING_STAGES = [
  "Extracting text...",
  "Generating script...",
  "Creating audio...",
];
const STAGE_INTERVAL_MS = 5000;
const REQUEST_TIMEOUT_MS = 90_000;

export default function App() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [stageIndex, setStageIndex] = useState(0);
  const [showAlternatives, setShowAlternatives] = useState(false);
  const intervalRef = useRef(null);

  // Cycle the loading-stage text while a request is in flight.
  useEffect(() => {
    if (loading) {
      setStageIndex(0);
      intervalRef.current = setInterval(() => {
        setStageIndex((i) => (i + 1) % LOADING_STAGES.length);
      }, STAGE_INTERVAL_MS);
      return () => clearInterval(intervalRef.current);
    }
    clearInterval(intervalRef.current);
    return undefined;
  }, [loading]);

  const handleGenerate = useCallback(async () => {
    if (!file) return;
    setLoading(true);
    setError("");
    setResult(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const { data } = await axios.post(`${API_URL}/generate`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: REQUEST_TIMEOUT_MS,
      });
      setResult(data);
    } catch (err) {
      const message =
        err?.response?.data?.detail ||
        err?.response?.data?.error ||
        err?.message ||
        "Something went wrong. Please try again.";
      setError(message);
      // Show alternatives if quota/limit error
      if (/quota|limit|429|exceeded|too many/i.test(message)) {
        setShowAlternatives(true);
      }
    } finally {
      setLoading(false);
    }
  }, [file]);

  return (
    <div className="min-h-full bg-dcBg text-dcText flex flex-col">
      <div className="w-full max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12 flex-1 flex flex-col gap-8">
        {/* Header */}
        <header className="animate-fade-in">
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
            DocuCast <span className="text-dcAccent">MVP</span>
          </h1>
          <p className="mt-2 text-dcMuted text-sm sm:text-base">
            Turn PDFs into Podcast-Style Explanations
          </p>
          <div className="mt-4 h-1 w-16 rounded-full bg-dcAccent" />
        </header>

        {/* Alternatives banner - shows when AI limits hit or user clicks */}
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4 animate-fade-in">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <p className="text-sm font-semibold text-emerald-300 flex items-center gap-2">
                <span>💡</span> AI limits finished? Free unlimited alternatives ready!
              </p>
              <p className="text-xs text-dcMuted mt-1 leading-relaxed">
                DocuCast now auto-falls back to free providers. No code change needed — just set a free key.
              </p>
            </div>
            <button
              onClick={() => setShowAlternatives(!showAlternatives)}
              className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 whitespace-nowrap border border-emerald-500/30 rounded-full px-3 py-1"
            >
              {showAlternatives ? "Hide" : "Show alternatives"}
            </button>
          </div>

          {showAlternatives && (
            <div className="mt-4 grid gap-3 text-xs">
              <div className="rounded-xl bg-dcCard border border-white/5 p-3">
                <p className="font-semibold text-white">⭐ Groq — Recommended (30 sec setup)</p>
                <p className="text-dcMuted mt-1">Free 14,400 req/day, fastest. No credit card.</p>
                <p className="mt-2 text-emerald-300">Get key: console.groq.com/keys → set GROQ_API_KEY in backend .env → restart</p>
                <code className="block mt-2 bg-black/30 rounded px-2 py-1 text-[11px] text-dcText">GROQ_API_KEY=gsk_...  +  LLM_PROVIDER=groq</code>
              </div>
              <div className="rounded-xl bg-dcCard border border-white/5 p-3">
                <p className="font-semibold text-white">⚡ Local — 100% Unlimited, Offline, No Key</p>
                <p className="text-dcMuted mt-1">Works forever even with no internet/API. Lower quality but never fails.</p>
                <code className="block mt-2 bg-black/30 rounded px-2 py-1 text-[11px] text-dcText">LLM_PROVIDER=local</code>
                <p className="mt-1 text-dcMuted">Or install Ollama for better local quality: ollama.com → ollama pull llama3.2 → ollama serve</p>
                <code className="block mt-2 bg-black/30 rounded px-2 py-1 text-[11px] text-dcText">OLLAMA_HOST=http://localhost:11434  +  LLM_PROVIDER=ollama</code>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="rounded-xl bg-dcCard border border-white/5 p-3">
                  <p className="font-semibold text-white">OpenRouter</p>
                  <p className="text-dcMuted mt-1">Free models like qwen/llama :free</p>
                  <p className="mt-1 text-emerald-300 text-[11px]">openrouter.ai/keys → OPENROUTER_API_KEY</p>
                </div>
                <div className="rounded-xl bg-dcCard border border-white/5 p-3">
                  <p className="font-semibold text-white">Hugging Face</p>
                  <p className="text-dcMuted mt-1">Free inference API</p>
                  <p className="mt-1 text-emerald-300 text-[11px]">huggingface.co/settings/tokens → HF_TOKEN</p>
                </div>
              </div>
              <p className="text-dcMuted text-[11px] leading-relaxed">
                💡 New backend is <b className="text-white">auto-fallback</b>: if Gemini hits 429/quota, it automatically tries Groq → OpenRouter → Ollama → local. No manual switch needed if you set GROQ_API_KEY alongside GEMINI_API_KEY.
              </p>
            </div>
          )}
        </div>

        <main className="flex-1 flex flex-col gap-6">
          <UploadSection
            file={file}
            setFile={setFile}
            onGenerate={handleGenerate}
            loading={loading}
            loadingMessage={LOADING_STAGES[stageIndex]}
          />

          {error && (
            <div
              role="alert"
              className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200 animate-fade-in"
            >
              <p className="font-medium">⚠️ {error}</p>
              {/quota|limit|429|exceeded|gemini/i.test(error) && (
                <div className="mt-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-3 text-xs text-emerald-200 leading-relaxed">
                  <p className="font-semibold">Quick fix — pick one (takes &lt;1 min):</p>
                  <ul className="list-disc list-inside mt-1 space-y-1">
                    <li><b>Groq (free)</b>: console.groq.com/keys → add <code className="bg-black/30 px-1 rounded">GROQ_API_KEY=gsk_...</code> to backend .env</li>
                    <li><b>Unlimited offline</b>: set <code className="bg-black/30 px-1 rounded">LLM_PROVIDER=local</code> → no API needed at all</li>
                    <li><b>Ollama (better offline)</b>: install ollama.com → <code className="bg-black/30 px-1 rounded">ollama pull llama3.2</code></li>
                  </ul>
                  <p className="mt-2">Backend now auto-retries with free providers — just set GROQ_API_KEY and reload.</p>
                </div>
              )}
            </div>
          )}

          {result && (
            <ResultSection
              script={result.script}
              audioBase64={result.audio_base64}
              audioError={result.audio_error}
              fileName={file?.name}
              provider={result.provider}
              providerNote={result.provider_note}
            />
          )}
        </main>

        {/* Footer */}
        <footer className="text-center text-xs text-dcMuted pt-6 border-t border-white/5">
          <p className="font-medium">
            Built Lean &bull; Zero-Cost Stack &bull; Solo Developer MVP &bull; Now with Free Unlimited Fallback
          </p>
          <p className="mt-2 leading-relaxed">
            Only upload documents you have rights to use. AI may summarize
            imperfectly. Local fallback is 100% private & unlimited.
          </p>
        </footer>
      </div>
    </div>
  );
}
