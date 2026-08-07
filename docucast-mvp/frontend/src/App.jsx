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
              {error}
            </div>
          )}

          {result && (
            <ResultSection
              script={result.script}
              audioBase64={result.audio_base64}
              audioError={result.audio_error}
              fileName={file?.name}
            />
          )}
        </main>

        {/* Footer */}
        <footer className="text-center text-xs text-dcMuted pt-6 border-t border-white/5">
          <p className="font-medium">
            Built Lean &bull; Zero-Cost Stack &bull; Solo Developer MVP
          </p>
          <p className="mt-2 leading-relaxed">
            Only upload documents you have rights to use. AI may summarize
            imperfectly. Free-tier requests may be used by Google to improve
            their products.
          </p>
        </footer>
      </div>
    </div>
  );
}
