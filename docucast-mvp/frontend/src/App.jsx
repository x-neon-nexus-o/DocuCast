import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import UploadSection from "./components/UploadSection.jsx";
import ResultSection from "./components/ResultSection.jsx";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
const TOKEN_KEY = "docucast_access_token";

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
  const [authLoading, setAuthLoading] = useState(true);
  const [authToken, setAuthToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
  const [authUser, setAuthUser] = useState(null);
  const [authError, setAuthError] = useState("");
  const [authMode, setAuthMode] = useState("login");
  const [credentials, setCredentials] = useState({ username: "", password: "" });
  const [loginLoading, setLoginLoading] = useState(false);
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [stageIndex, setStageIndex] = useState(0);
  const [showAlternatives, setShowAlternatives] = useState(false);
  const intervalRef = useRef(null);

  const clearSession = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setAuthToken("");
    setAuthUser(null);
    setFile(null);
    setError("");
    setResult(null);
  }, []);

  useEffect(() => {
    let isActive = true;

    const verifySession = async () => {
      const storedToken = localStorage.getItem(TOKEN_KEY);
      if (!storedToken) {
        if (isActive) setAuthLoading(false);
        return;
      }

      try {
        const { data } = await axios.get(`${API_URL}/auth/me`, {
          headers: { Authorization: `Bearer ${storedToken}` },
          timeout: 15_000,
        });
        if (!isActive) return;
        setAuthToken(storedToken);
        setAuthUser(data.user);
      } catch {
        if (!isActive) return;
        clearSession();
      } finally {
        if (isActive) setAuthLoading(false);
      }
    };

    verifySession();
    return () => {
      isActive = false;
    };
  }, [clearSession]);

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

  const handleLogin = useCallback(
    async (event) => {
      event.preventDefault();
      setAuthError("");
      setLoginLoading(true);

      try {
        const { data } = await axios.post(`${API_URL}/auth/${authMode}`, credentials, {
          timeout: 15_000,
        });
        localStorage.setItem(TOKEN_KEY, data.access_token);
        setAuthToken(data.access_token);
        setAuthUser(data.user);
        setCredentials({ username: "", password: "" });
      } catch (err) {
        setAuthError(
          err?.response?.data?.detail ||
            err?.message ||
            `Unable to ${authMode === "register" ? "sign up" : "sign in"}. Please try again.`,
        );
      } finally {
        setLoginLoading(false);
      }
    },
    [authMode, credentials],
  );

  const handleLogout = useCallback(() => {
    clearSession();
    setShowAlternatives(false);
  }, [clearSession]);

  const handleGenerate = useCallback(async () => {
    if (!file) return;
    setLoading(true);
    setError("");
    setResult(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const { data } = await axios.post(`${API_URL}/generate`, formData, {
        headers: {
          "Content-Type": "multipart/form-data",
          Authorization: `Bearer ${authToken}`,
        },
        timeout: REQUEST_TIMEOUT_MS,
      });
      setResult(data);
    } catch (err) {
      const message =
        err?.response?.data?.detail ||
        err?.response?.data?.error ||
        err?.message ||
        "Something went wrong. Please try again.";
      if (err?.response?.status === 401) {
        clearSession();
        setAuthError(message);
        return;
      }
      setError(message);
      // Show alternatives if quota/limit error
      if (/quota|limit|429|exceeded|too many/i.test(message)) {
        setShowAlternatives(true);
      }
    } finally {
      setLoading(false);
    }
  }, [authToken, clearSession, file]);

  if (authLoading) {
    return (
      <div className="min-h-full bg-dcBg text-dcText flex items-center justify-center px-4">
        <div className="w-full max-w-md rounded-3xl border border-white/10 bg-dcCard/90 shadow-2xl shadow-black/30 p-6 sm:p-8 text-center animate-fade-in">
          <div className="mx-auto mb-4 h-11 w-11 rounded-full border-2 border-dcAccent/30 border-t-dcAccent animate-spin-slow" />
          <h1 className="text-2xl font-bold tracking-tight">DocuCast <span className="text-dcAccent">MVP</span></h1>
          <p className="mt-2 text-sm text-dcMuted">Checking your session...</p>
        </div>
      </div>
    );
  }

  if (!authToken) {
    return (
      <div className="min-h-full bg-dcBg text-dcText flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-4xl grid gap-6 lg:grid-cols-[1.1fr_0.9fr] items-stretch">
          <section className="rounded-3xl border border-white/10 bg-dcCard/85 shadow-2xl shadow-black/30 p-6 sm:p-8 animate-fade-in">
            <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
              DocuCast <span className="text-dcAccent">MVP</span>
            </h1>
            <p className="mt-3 text-sm sm:text-base text-dcMuted max-w-xl leading-relaxed">
              Sign in to turn PDFs into podcast-style explanations. The backend now protects the upload flow with a simple bearer token session.
            </p>
            <div className="mt-6 grid gap-3 text-sm text-dcMuted">
              <div className="rounded-2xl bg-dcBg/50 border border-white/5 px-4 py-3">
                <p className="font-semibold text-white">What you get</p>
                <p className="mt-1 leading-relaxed">Login-gated PDF upload, generated scripts, and audio synthesis behind one session.</p>
              </div>
              <div className="rounded-2xl bg-dcBg/50 border border-white/5 px-4 py-3">
                <p className="font-semibold text-white">Demo credentials</p>
                <p className="mt-1 leading-relaxed">Use the username and password configured in the backend environment. If you have not changed them, the local defaults are available for development.</p>
              </div>
            </div>
          </section>

          <section className="rounded-3xl border border-white/10 bg-dcCard/95 shadow-2xl shadow-black/30 p-6 sm:p-8 animate-fade-in">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h2 className="text-xl font-semibold">{authMode === "register" ? "Create account" : "Sign in"}</h2>
                <p className="mt-2 text-sm text-dcMuted">
                  {authMode === "register"
                    ? "Create a new account to get started."
                    : "Enter your credentials to continue."}
                </p>
              </div>

              <button
                type="button"
                onClick={() => {
                  setAuthError("");
                  setAuthMode((current) => (current === "login" ? "register" : "login"));
                }}
                className="rounded-full border border-white/10 bg-dcBg/50 px-3 py-1.5 text-xs font-semibold text-dcMuted hover:text-white hover:border-dcAccent/50"
              >
                {authMode === "register" ? "Have an account? Sign in" : "New here? Register"}
              </button>
            </div>

            <form onSubmit={handleLogin} className="mt-6 space-y-4">
              <label className="block">
                <span className="block text-xs font-semibold uppercase tracking-wide text-dcMuted">Username</span>
                <input
                  type="text"
                  value={credentials.username}
                  onChange={(event) => setCredentials((current) => ({ ...current, username: event.target.value }))}
                  autoComplete="username"
                  className="mt-2 w-full rounded-xl border border-white/10 bg-dcBg/70 px-4 py-3 text-sm text-dcText placeholder:text-dcMuted/60 focus:outline-none focus:ring-2 focus:ring-dcAccent/60 focus:border-transparent"
                  placeholder="admin"
                />
              </label>

              <label className="block">
                <span className="block text-xs font-semibold uppercase tracking-wide text-dcMuted">Password</span>
                <input
                  type="password"
                  value={credentials.password}
                  onChange={(event) => setCredentials((current) => ({ ...current, password: event.target.value }))}
                  autoComplete="current-password"
                  className="mt-2 w-full rounded-xl border border-white/10 bg-dcBg/70 px-4 py-3 text-sm text-dcText placeholder:text-dcMuted/60 focus:outline-none focus:ring-2 focus:ring-dcAccent/60 focus:border-transparent"
                  placeholder="••••••••"
                />
              </label>

              {authError && (
                <div role="alert" className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                  {authError}
                </div>
              )}

              <button
                type="submit"
                disabled={loginLoading || !credentials.username.trim() || !credentials.password.trim()}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-dcAccent px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-dcAccent/20 transition-all hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
              >
                {loginLoading ? (authMode === "register" ? "Creating account..." : "Signing in...") : authMode === "register" ? "Create account" : "Sign in"}
              </button>
            </form>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-dcBg text-dcText flex flex-col">
      <div className="w-full max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12 flex-1 flex flex-col gap-8">
        {/* Header */}
        <header className="animate-fade-in flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
              DocuCast <span className="text-dcAccent">MVP</span>
            </h1>
            <p className="mt-2 text-dcMuted text-sm sm:text-base">
              Turn PDFs into Podcast-Style Explanations
            </p>
            <div className="mt-4 h-1 w-16 rounded-full bg-dcAccent" />
          </div>

          <div className="rounded-2xl border border-white/10 bg-dcCard/70 px-4 py-3 text-sm">
            <p className="text-xs uppercase tracking-wide text-dcMuted">Signed in as</p>
            <div className="mt-1 flex items-center gap-3">
              <span className="font-semibold text-white">{authUser?.username || "Authenticated user"}</span>
              <button
                type="button"
                onClick={handleLogout}
                className="text-xs font-semibold text-dcAccent hover:text-blue-400"
              >
                Log out
              </button>
            </div>
          </div>
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
