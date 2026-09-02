import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import UploadSection from "./components/UploadSection.jsx";
import ResultSection from "./components/ResultSection.jsx";

const API_URL = import.meta.env.VITE_API_URL || "/api";
const TOKEN_KEY = "docucast_access_token";

// Cycled loading messages. The backend runs synchronously in one request, so
// these are a timed UI sequence, NOT real server progress.
const LOADING_STAGES = [
  "Reading the document…",
  "Extracting tables, images & graphs…",
  "Analyzing visual content…",
  "Writing the two-host script…",
  "Synthesizing voices…",
];
const STAGE_INTERVAL_MS = 4500;
const REQUEST_TIMEOUT_MS = 240_000;

export const DEFAULT_STUDIO = {
  mode: "dialogue",
  length: "standard",
  tone: "conversational",
  audience: "general",
  focus: "",
};

/* ------------------------------------------------------------------ */
/* Ambient aurora backdrop                                             */
/* ------------------------------------------------------------------ */
function AuroraBackdrop() {
  return (
    <div className="aurora-field" aria-hidden="true">
      <div className="aurora-blob aurora-blob--violet animate-drift" />
      <div className="aurora-blob aurora-blob--cyan animate-drift-alt" />
      <div className="aurora-blob aurora-blob--magenta animate-drift" style={{ animationDelay: "-9s" }} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cinematic scroll reveal                                             */
/* ------------------------------------------------------------------ */
export function Reveal({ children, delay = 0, className = "", as: Tag = "div" }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <Tag
      ref={ref}
      className={`reveal ${visible ? "is-visible" : ""} ${className}`}
      style={{ "--reveal-delay": `${delay}ms` }}
    >
      {children}
    </Tag>
  );
}

function Logo({ size = "text-xl" }) {
  return (
    <span className={`font-display font-bold tracking-tight ${size}`}>
      Docu<span className="text-aurora">Cast</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */
export default function App() {
  const [authLoading, setAuthLoading] = useState(true);
  const [authToken, setAuthToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
  const [authUser, setAuthUser] = useState(null);
  const [authError, setAuthError] = useState("");
  const [authMode, setAuthMode] = useState("login");
  const [credentials, setCredentials] = useState({ username: "", password: "" });
  const [loginLoading, setLoginLoading] = useState(false);
  const [file, setFile] = useState(null);
  const [studio, setStudio] = useState(DEFAULT_STUDIO);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [stageIndex, setStageIndex] = useState(0);
  const intervalRef = useRef(null);
  const resultRef = useRef(null);

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
        setStageIndex((i) => Math.min(i + 1, LOADING_STAGES.length - 1));
      }, STAGE_INTERVAL_MS);
      return () => clearInterval(intervalRef.current);
    }
    clearInterval(intervalRef.current);
    return undefined;
  }, [loading]);

  // Smooth-scroll to the result when it lands.
  useEffect(() => {
    if (result && resultRef.current) {
      resultRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [result]);

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
  }, [clearSession]);

  const handleGenerate = useCallback(async () => {
    if (!file) return;
    setLoading(true);
    setError("");
    setResult(null);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("mode", studio.mode);
    formData.append("length", studio.length);
    formData.append("tone", studio.tone);
    formData.append("audience", studio.audience);
    formData.append("focus", studio.focus || "");

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
    } finally {
      setLoading(false);
    }
  }, [authToken, clearSession, file, studio]);

  /* ------------------------------------------------------------ */
  /* Session check splash                                          */
  /* ------------------------------------------------------------ */
  if (authLoading) {
    return (
      <div className="min-h-full text-ink flex items-center justify-center px-4">
        <AuroraBackdrop />
        <div className="glass rounded-3xl p-8 sm:p-10 text-center animate-fade-in max-w-md w-full">
          <div className="mx-auto mb-5 h-11 w-11 rounded-full border-2 border-aurora-violet/30 border-t-aurora-violet animate-spin-slow" />
          <Logo size="text-3xl" />
          <p className="mt-3 text-sm text-dim">Waking up the studio…</p>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------ */
  /* Auth screen                                                   */
  /* ------------------------------------------------------------ */
  if (!authToken) {
    return (
      <div className="min-h-full text-ink flex items-center justify-center px-4 py-10">
        <AuroraBackdrop />
        <div className="w-full max-w-5xl grid gap-6 lg:grid-cols-[1.15fr_0.85fr] items-stretch">
          <section className="glass glass-hover rounded-[2rem] p-8 sm:p-12 animate-fade-up flex flex-col justify-center">
            <p className="text-xs font-semibold uppercase tracking-[0.35em] text-aurora-cyan">
              Document → Podcast Studio
            </p>
            <h1 className="mt-4 font-display text-mega font-bold">
              Documents,
              <br />
              <span className="text-aurora text-aurora--animated">spoken.</span>
            </h1>
            <p className="mt-5 text-base sm:text-lg text-dim max-w-xl leading-relaxed">
              Drop a PDF, slide deck, markdown file or plain notes. Two AI hosts
              turn it into a podcast — including what's inside your{" "}
              <span className="text-ink font-medium">tables, graphs, images and handwriting</span>.
            </p>
            <ul className="mt-8 grid gap-3 text-sm text-dim sm:grid-cols-2">
              {[
                ["◈", "PDF, PPTX, MD & TXT"],
                ["◉", "Two-host dialogue audio"],
                ["◫", "Tables & chart data narrated"],
                ["✎", "Handwriting & image analysis"],
              ].map(([glyph, label]) => (
                <li key={label} className="flex items-center gap-3">
                  <span className="text-aurora-violet" aria-hidden="true">{glyph}</span>
                  {label}
                </li>
              ))}
            </ul>
          </section>

          <section className="glass-deep rounded-[2rem] p-8 sm:p-10 animate-fade-up" style={{ animationDelay: "120ms" }}>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h2 className="font-display text-2xl font-semibold">
                  {authMode === "register" ? "Create account" : "Sign in"}
                </h2>
                <p className="mt-2 text-sm text-dim">
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
                className="rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs font-semibold text-dim transition-colors hover:text-ink hover:border-aurora-violet/50"
              >
                {authMode === "register" ? "Have an account? Sign in" : "New here? Register"}
              </button>
            </div>

            <form onSubmit={handleLogin} className="mt-8 space-y-5">
              <label className="block">
                <span className="block text-xs font-semibold uppercase tracking-widest text-dim">Username</span>
                <input
                  type="text"
                  value={credentials.username}
                  onChange={(event) => setCredentials((current) => ({ ...current, username: event.target.value }))}
                  autoComplete="username"
                  className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-aurora-violet/60 focus:border-transparent transition-shadow"
                  placeholder="admin"
                />
              </label>

              <label className="block">
                <span className="block text-xs font-semibold uppercase tracking-widest text-dim">Password</span>
                <input
                  type="password"
                  value={credentials.password}
                  onChange={(event) => setCredentials((current) => ({ ...current, password: event.target.value }))}
                  autoComplete="current-password"
                  className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-aurora-violet/60 focus:border-transparent transition-shadow"
                  placeholder="••••••••"
                />
              </label>

              {authError && (
                <div role="alert" className="rounded-xl border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                  {authError}
                </div>
              )}

              <button
                type="submit"
                disabled={loginLoading || !credentials.username.trim() || !credentials.password.trim()}
                className="btn-aurora w-full inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3.5 text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loginLoading
                  ? authMode === "register" ? "Creating account…" : "Signing in…"
                  : authMode === "register" ? "Create account" : "Enter the studio"}
              </button>
            </form>
          </section>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------ */
  /* Main studio                                                   */
  /* ------------------------------------------------------------ */
  return (
    <div className="min-h-full text-ink flex flex-col">
      <AuroraBackdrop />

      {/* Glass nav */}
      <header className="sticky top-0 z-40">
        <div className="glass-deep border-x-0 border-t-0 rounded-none">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-4 sm:px-6 py-3.5">
            <Logo />
            <div className="flex items-center gap-4">
              <span className="hidden sm:inline text-xs text-dim">
                <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-aurora-teal animate-pulse-soft align-middle" aria-hidden="true" />
                {authUser?.username || "signed in"}
              </span>
              <button
                type="button"
                onClick={handleLogout}
                className="rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs font-semibold text-dim transition-all hover:text-ink hover:border-aurora-magenta/50"
              >
                Log out
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="w-full max-w-5xl mx-auto px-4 sm:px-6 pb-16 flex-1 flex flex-col">
        {/* Hero */}
        <section className="pt-14 sm:pt-20 pb-10 sm:pb-14 text-center">
          <Reveal>
            <p className="text-[11px] font-semibold uppercase tracking-[0.4em] text-aurora-cyan">
              PDF · PPTX · Markdown · Text
            </p>
          </Reveal>
          <Reveal delay={90}>
            <h1 className="mt-4 font-display text-mega font-bold">
              Every page becomes
              <br />
              <span className="text-aurora text-aurora--animated">a conversation.</span>
            </h1>
          </Reveal>
          <Reveal delay={180}>
            <p className="mx-auto mt-6 max-w-2xl text-base sm:text-lg text-dim leading-relaxed">
              DocuCast reads the whole document — body text, tables, graphs, images,
              even handwritten notes — and hands it to two hosts who actually talk about it.
            </p>
          </Reveal>
        </section>

        <main className="flex flex-col gap-8">
          <Reveal delay={80}>
            <UploadSection
              file={file}
              setFile={setFile}
              studio={studio}
              setStudio={setStudio}
              onGenerate={handleGenerate}
              loading={loading}
              loadingMessage={LOADING_STAGES[stageIndex]}
              stageIndex={stageIndex}
              stageCount={LOADING_STAGES.length}
            />
          </Reveal>

          {error && (
            <div
              role="alert"
              className="glass rounded-2xl border-red-400/30 px-5 py-4 text-sm text-red-200 animate-fade-in"
            >
              <p className="font-medium">⚠ {error}</p>
              {/quota|limit|429|exceeded|gemini/i.test(error) && (
                <p className="mt-2 text-xs text-red-200/70 leading-relaxed">
                  Tip: the backend auto-falls back to free providers. Set{" "}
                  <code className="rounded bg-black/40 px-1.5 py-0.5">GROQ_API_KEY</code> (free at
                  console.groq.com) or <code className="rounded bg-black/40 px-1.5 py-0.5">LLM_PROVIDER=local</code>{" "}
                  in the backend .env for unlimited offline generation.
                </p>
              )}
            </div>
          )}

          <div ref={resultRef} className="scroll-mt-24">
            {result && (
              <ResultSection
                key={result.filename + (result.script?.length || 0)}
                result={result}
                fileName={file?.name}
              />
            )}
          </div>

          {/* Why DocuCast strip */}
          {!result && !loading && (
            <section aria-labelledby="edge-heading" className="mt-6">
              <Reveal>
                <h2 id="edge-heading" className="font-display text-giant font-semibold text-center">
                  Built where other tools <span className="text-aurora">go quiet.</span>
                </h2>
              </Reveal>
              <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  {
                    title: "Visuals are narrated",
                    body: "Tables, chart data, figures and image contents make it into the audio — not just the paragraphs around them.",
                    glyph: "◫",
                    delay: 0,
                  },
                  {
                    title: "You direct the show",
                    body: "Two hosts or solo. Two minutes or seven. Calm or energetic, for students or executives — with a custom focus prompt.",
                    glyph: "◉",
                    delay: 90,
                  },
                  {
                    title: "It never breaks",
                    body: "Seven LLM fallbacks and four TTS engines, ending in fully-offline ones. No daily caps, no dead ends.",
                    glyph: "∞",
                    delay: 180,
                  },
                  {
                    title: "Yours to keep",
                    body: "Download the audio, copy the transcript, inspect exactly what was extracted from every page.",
                    glyph: "⇩",
                    delay: 270,
                  },
                ].map((f) => (
                  <Reveal key={f.title} delay={f.delay}>
                    <article className="glass glass-hover rounded-2xl p-5 h-full">
                      <span className="text-2xl text-aurora-violet" aria-hidden="true">{f.glyph}</span>
                      <h3 className="mt-3 font-display text-base font-semibold">{f.title}</h3>
                      <p className="mt-2 text-sm text-dim leading-relaxed">{f.body}</p>
                    </article>
                  </Reveal>
                ))}
              </div>
            </section>
          )}
        </main>

        {/* Footer */}
        <footer className="mt-16 border-t border-white/5 pt-8 text-center text-xs text-faint">
          <p className="font-medium text-dim">
            DocuCast · zero-cost stack · auto-fallback AI · audio that never fails
          </p>
          <p className="mt-2 leading-relaxed max-w-xl mx-auto">
            Only upload documents you have rights to use. AI may summarize imperfectly —
            check the extraction panel to see exactly what was read.
          </p>
        </footer>
      </div>
    </div>
  );
}
