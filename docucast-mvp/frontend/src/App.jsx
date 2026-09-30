import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import UploadSection from "./components/UploadSection.jsx";
import ResultSection from "./components/ResultSection.jsx";
import HistorySection from "./components/HistorySection.jsx";
import DashboardSection from "./components/DashboardSection.jsx";
import PlaylistSection from "./components/PlaylistSection.jsx";
import HalftoneFlow from "./components/HalftoneFlow.jsx";

const API_URL = import.meta.env.VITE_API_URL || "/api";
const TOKEN_KEY = "docucast_access_token";
const STUDIO_KEY = "docucast_studio_prefs";
const THEME_KEY = "docucast_theme";

// Apply the theme attribute before first paint wherever possible.
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

function loadTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* storage unavailable */
  }
  return "dark"; // dark-first design; default stays dark
}

// Server-driven job stages (the backend reports REAL progress via /jobs/{id}).
const STAGE_LABELS = {
  queued: "Queued…",
  parsing: "Reading the document — text, tables, images…",
  script: "Writing the script…",
  "show notes": "Drafting show notes & chapters…",
  synthesizing: "Synthesizing voices…",
  saving: "Saving to your library…",
  done: "Done",
};
const POLL_INTERVAL_MS = 1500;
const JOB_TIMEOUT_MS = 300_000;

export const DEFAULT_STUDIO = {
  mode: "dialogue",
  length: "standard",
  tone: "conversational",
  audience: "general",
  focus: "",
  language: "en",
  host_a_name: "NOVA",
  host_b_name: "RHYS",
  host_a_voice: "en-US-JennyNeural",
  host_b_voice: "en-US-GuyNeural",
  host_a_rate: 0,
  host_b_rate: 0,
  host_a_pitch: 0,
  host_b_pitch: 0,
};

/* ------------------------------------------------------------------ */
// Restore saved studio preferences, keeping only known-good values.
function loadStudioPrefs() {
  try {
    const raw = localStorage.getItem(STUDIO_KEY);
    if (!raw) return DEFAULT_STUDIO;
    const saved = JSON.parse(raw);
    const valid = {
      mode: ["dialogue", "solo"],
      language: ["en", "es", "fr", "de", "it", "pt", "hi", "ja"],
      length: ["brief", "standard", "deep"],
      tone: ["conversational", "energetic", "calm", "expert"],
      audience: ["general", "student", "expert", "executive"],
    };
    const merged = { ...DEFAULT_STUDIO };
    for (const [key, allowed] of Object.entries(valid)) {
      if (allowed.includes(saved[key])) merged[key] = saved[key];
    }
    if (typeof saved.focus === "string") merged.focus = saved.focus.slice(0, 300);
    for (const key of ["host_a_name", "host_b_name", "host_a_voice", "host_b_voice"]) {
      if (typeof saved[key] === "string") merged[key] = saved[key].slice(0, 80);
    }
    for (const key of ["host_a_rate", "host_b_rate", "host_a_pitch", "host_b_pitch"]) {
      if (Number.isFinite(Number(saved[key]))) merged[key] = Number(saved[key]);
    }
    return merged;
  } catch {
    return DEFAULT_STUDIO;
  }
}

/* ------------------------------------------------------------------ */
/* Ambient backdrop: WebGL halftone flow over the aurora field          */
/* (the aurora gradient stays as the non-WebGL fallback layer)        */
/* ------------------------------------------------------------------ */
function AuroraBackdrop() {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = (e) => setReducedMotion(e.matches);
    setReducedMotion(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return (
    <div className="aurora-field" aria-hidden="true">
      {!reducedMotion && (
        <>
          <div className="aurora-blob aurora-blob--violet animate-drift" />
          <div className="aurora-blob aurora-blob--cyan animate-drift-alt" />
          <div className="aurora-blob aurora-blob--magenta animate-drift" style={{ animationDelay: "-9s" }} />
        </>
      )}
      <HalftoneFlow className="halftone-canvas" />
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
  const [authMode, setAuthMode] = useState(() => new URLSearchParams(window.location.search).has("reset_token") ? "reset" : "login");
  const [credentials, setCredentials] = useState({ username: "", email: "", password: "", confirmPassword: "" });
  const [resetToken, setResetToken] = useState(() => new URLSearchParams(window.location.search).get("reset_token") || "");
  const [loginLoading, setLoginLoading] = useState(false);
  const [resetMessage, setResetMessage] = useState("");
  const [files, setFiles] = useState([]); // multi-document sources (max 5)
  const [studio, setStudio] = useState(loadStudioPrefs);
  const [loading, setLoading] = useState(false);
  const [jobStage, setJobStage] = useState("queued");
  const [jobPercent, setJobPercent] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(0);
  const [regenerating, setRegenerating] = useState(false);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [dashboardStats, setDashboardStats] = useState(null);
  const [activeView, setActiveView] = useState("dashboard"); // dashboard | studio
  const [theme, setTheme] = useState(loadTheme);
  const intervalRef = useRef(null);
  const elapsedRef = useRef(null);
  const resultRef = useRef(null);

  const clearSession = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setAuthToken("");
    setAuthUser(null);
    setFiles([]);
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

  // Persist studio preferences whenever they change.
  useEffect(() => {
    try {
      localStorage.setItem(STUDIO_KEY, JSON.stringify(studio));
    } catch {
      /* storage unavailable */
    }
  }, [studio]);

  // Apply + persist the theme whenever it changes.
  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);

  // Honest elapsed clock while a job runs (complements the real server stages).
  useEffect(() => {
    if (loading) {
      setElapsedSeconds(0);
      const t = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
      return () => clearInterval(t);
    }
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
      setResetMessage("");
      setLoginLoading(true);

      try {
        if (authMode === "forgot") {
          const { data } = await axios.post(`${API_URL}/auth/forgot-password`, { email: credentials.email }, { timeout: 15_000 });
          setResetMessage(data.message);
          return;
        }
        if (authMode === "reset") {
          if (credentials.password !== credentials.confirmPassword) throw new Error("Passwords do not match.");
          const { data } = await axios.post(`${API_URL}/auth/reset-password`, { token: resetToken, password: credentials.password }, { timeout: 15_000 });
          setResetMessage(data.message);
          setAuthMode("login");
          window.history.replaceState({}, "", window.location.pathname);
          setCredentials({ username: "", email: "", password: "", confirmPassword: "" });
          return;
        }
        const payload = authMode === "register"
          ? { username: credentials.username, email: credentials.email, password: credentials.password }
          : { username: credentials.username, password: credentials.password };
        const { data } = await axios.post(`${API_URL}/auth/${authMode}`, payload, {
          timeout: 15_000,
        });
        localStorage.setItem(TOKEN_KEY, data.access_token);
        setAuthToken(data.access_token);
        setAuthUser(data.user);
        setCredentials({ username: "", email: "", password: "", confirmPassword: "" });
      } catch (err) {
        setAuthError(
          err?.response?.data?.detail ||
            err?.message ||
            err?.message || `Unable to ${authMode === "register" ? "sign up" : "sign in"}. Please try again.`,
        );
      } finally {
        setLoginLoading(false);
      }
    },
    [authMode, credentials, resetToken],
  );

  const handleLogout = useCallback(() => {
    clearSession();
  }, [clearSession]);

  // Count down a 429 retry window so the button re-enables visibly.
  useEffect(() => {
    if (retryAfterSeconds <= 0) return undefined;
    const t = setInterval(() => setRetryAfterSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [retryAfterSeconds > 0]);

  // Poll a backend job until done/error; updates real stage + percent.
  const pollJob = useCallback(async (jobId) => {
    const deadline = Date.now() + JOB_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { data: job } = await axios.get(`${API_URL}/jobs/${jobId}`, {
        headers: { Authorization: `Bearer ${authToken}` },
        timeout: 15_000,
      });
      setJobStage(job.stage || "queued");
      setJobPercent(job.percent || 0);
      if (job.status === "done") return { ok: true, result: job.result };
      if (job.status === "error") return { ok: false, error: job.error || "Generation failed." };
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return { ok: false, error: "This is taking unusually long — please try again." };
  }, [authToken]);

  const handleGenerate = useCallback(async (params = {}) => {
    if (retryAfterSeconds > 0) return;
    const isBatch = !!params.batch;
    const targetUrl = params.url;
    const targetFiles = params.files || files;

    if (!isBatch && !targetUrl && (!targetFiles || !targetFiles.length)) return;

    setLoading(true);
    setError("");
    setResult(null);
    setJobStage("queued");
    setJobPercent(0);

    const formData = new FormData();
    formData.append("mode", studio.mode);
    formData.append("length", studio.length);
    formData.append("tone", studio.tone);
    formData.append("audience", studio.audience);
    formData.append("focus", studio.focus || "");
    formData.append("language", studio.language || "en");
    for (const key of ["host_a_name", "host_b_name", "host_a_voice", "host_b_voice", "host_a_rate", "host_b_rate", "host_a_pitch", "host_b_pitch"]) {
      formData.append(key, String(studio[key] ?? ""));
    }
    if (params.redactedSource) formData.append("redacted_source", params.redactedSource);

    let endpoint = `${API_URL}/generate`;
    if (isBatch) {
      endpoint = `${API_URL}/batch-generate`;
      formData.append("playlist_title", params.playlistTitle || "Untitled Series");
      if (params.description) formData.append("description", params.description);
      if (params.urls) formData.append("urls", params.urls);
      if (targetFiles?.length) {
        targetFiles.forEach((f) => formData.append("files", f));
      }
    } else if (targetUrl) {
      formData.append("url", targetUrl);
      setActiveView("studio");
    } else {
      targetFiles.forEach((f) => formData.append("files", f));
      setActiveView("studio");
    }

    try {
      const { data } = await axios.post(endpoint, formData, {
        headers: {
          "Content-Type": "multipart/form-data",
          Authorization: `Bearer ${authToken}`,
        },
        timeout: 60_000,
      });
      const outcome = await pollJob(data.job_id);
      if (!outcome.ok) throw { response: { data: { detail: outcome.error } } };
      
      if (isBatch) {
        setActiveView("playlists");
        setHistoryRefreshKey((k) => k + 1);
      } else {
        setResult(outcome.result);
        setHistoryRefreshKey((k) => k + 1);
      }
    } catch (err) {
      const message =
        err?.response?.data?.detail ||
        err?.response?.data?.error ||
        err?.message ||
        "Something went wrong. Please try again.";
      if (err?.response?.status === 429) {
        const match = message.match(/in (\d+) seconds?/i);
        setRetryAfterSeconds(match ? parseInt(match[1], 10) : 60);
      }
      if (err?.response?.status === 401) {
        clearSession();
        setAuthError(message);
        return;
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [authToken, clearSession, files, pollJob, retryAfterSeconds, studio]);

  // Regenerate the CURRENT episode with the (possibly changed) studio settings.
  const handleRegenerate = useCallback(async () => {
    const episodeId = result?.episode_id;
    if (!episodeId || regenerating) return;
    setRegenerating(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("episode_id", episodeId);
      formData.append("mode", studio.mode);
      formData.append("length", studio.length);
      formData.append("tone", studio.tone);
      formData.append("audience", studio.audience);
      formData.append("focus", studio.focus || "");
      formData.append("language", studio.language || "en");
      for (const key of ["host_a_name", "host_b_name", "host_a_voice", "host_b_voice", "host_a_rate", "host_b_rate", "host_a_pitch", "host_b_pitch"]) {
        formData.append(key, String(studio[key] ?? ""));
      }
      const { data } = await axios.post(`${API_URL}/regenerate`, formData, {
        headers: { "Content-Type": "multipart/form-data", Authorization: `Bearer ${authToken}` },
        timeout: 30_000,
      });
      const outcome = await pollJob(data.job_id);
      if (!outcome.ok) throw { response: { data: { detail: outcome.error } } };
      // Merge so analysis/filename stay from the original; script/audio are new.
      setResult((prev) => ({ ...prev, ...outcome.result }));
      setHistoryRefreshKey((k) => k + 1);
    } catch (err) {
      const message = err?.response?.data?.detail || err?.message || "Regeneration failed.";
      if (err?.response?.status === 429) {
        const match = message.match(/in (\d+) seconds?/i);
        setRetryAfterSeconds(match ? parseInt(match[1], 10) : 60);
      }
      setError(message);
    } finally {
      setRegenerating(false);
    }
  }, [authToken, pollJob, regenerating, result, studio]);

  // Re-synthesize audio from a user-edited script (no LLM, no re-parse).
  const handleResynthesize = useCallback(async (editedScript) => {
    if (!editedScript?.trim() || regenerating) return;
    setRegenerating(true);
    setError("");
    try {
      const { data } = await axios.post(`${API_URL}/resynthesize`, { script: editedScript }, {
        headers: { Authorization: `Bearer ${authToken}` },
        timeout: 30_000,
      });
      const outcome = await pollJob(data.job_id);
      if (!outcome.ok) throw { response: { data: { detail: outcome.error } } };
      setResult((prev) => ({ ...prev, ...outcome.result }));
    } catch (err) {
      const message = err?.response?.data?.detail || err?.message || "Re-synthesis failed.";
      setError(message);
    } finally {
      setRegenerating(false);
    }
  }, [authToken, pollJob, regenerating]);

  // Open an episode from anywhere (dashboard, history) with its audio fetched.
  const openEpisodeById = useCallback(async (episodeId) => {
    try {
      const { data } = await axios.get(`${API_URL}/episodes/${episodeId}`, {
        headers: { Authorization: `Bearer ${authToken}` },
        timeout: 30_000,
      });
      setResult({
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
      setActiveView("studio");
      if (resultRef.current) {
        resultRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    } catch (err) {
      setError(err?.response?.data?.detail || err?.message || "Could not open this episode.");
    }
  }, [authToken]);

  // Dashboard CTA routing.
  const handleDashboardActivate = useCallback((key) => {
    if (key === "new") {
      setActiveView("studio");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (key === "recent" || key === "tune") {
      setActiveView("studio");
      window.setTimeout(() => {
        document.getElementById("episode-library")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 80);
    }
  }, []);

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
                ["◈", "PDF, PPTX, DOCX, MD & TXT"],
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
                  {authMode === "register" ? "Create account" : authMode === "forgot" ? "Forgot password" : authMode === "reset" ? "Set a new password" : "Sign in"}
                </h2>
                <p className="mt-2 text-sm text-dim">
                  {authMode === "register"
                    ? "Create a new account to get started."
                    : authMode === "forgot"
                    ? "Enter your registered email. We will send a secure reset link."
                    : authMode === "reset"
                    ? "Choose a strong password for your account."
                    : "Enter your credentials to continue."}
                </p>
              </div>

              {authMode !== "reset" && (
              <button
                type="button"
                onClick={() => {
                  setAuthError("");
                  setResetMessage("");
                  setAuthMode((current) => (current === "login" ? "register" : "login"));
                }}
                className="rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs font-semibold text-dim transition-colors hover:text-ink hover:border-aurora-violet/50"
              >
                {authMode === "register" ? "Have an account? Sign in" : "New here? Register"}
              </button>
              )}
            </div>

            <form onSubmit={handleLogin} className="mt-8 space-y-5">
              {authMode !== "reset" && authMode !== "forgot" && <label className="block">
                <span className="block text-xs font-semibold uppercase tracking-widest text-dim">Username</span>
                <input
                  type="text"
                  value={credentials.username}
                  onChange={(event) => setCredentials((current) => ({ ...current, username: event.target.value }))}
                  autoComplete="username"
                  className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-aurora-violet/60 focus:border-transparent transition-shadow"
                  placeholder="admin"
                />
              </label>}

              {authMode === "register" && <label className="block">
                <span className="block text-xs font-semibold uppercase tracking-widest text-dim">Email</span>
                <input type="email" value={credentials.email} onChange={(event) => setCredentials((current) => ({ ...current, email: event.target.value }))} autoComplete="email" className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-aurora-violet/60" placeholder="you@example.com" />
              </label>}

              {(authMode === "forgot") && <label className="block">
                <span className="block text-xs font-semibold uppercase tracking-widest text-dim">Registered email</span>
                <input type="email" value={credentials.email} onChange={(event) => setCredentials((current) => ({ ...current, email: event.target.value }))} autoComplete="email" className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-aurora-cyan/60" placeholder="you@example.com" />
              </label>}

              {authMode !== "forgot" && <label className="block">
                <span className="block text-xs font-semibold uppercase tracking-widest text-dim">Password</span>
                <input
                  type="password"
                  value={credentials.password}
                  onChange={(event) => setCredentials((current) => ({ ...current, password: event.target.value }))}
                  autoComplete={authMode === "reset" ? "new-password" : "current-password"}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-aurora-violet/60 focus:border-transparent transition-shadow"
                  placeholder="••••••••"
                />
              </label>}

              {authMode === "reset" && <label className="block">
                <span className="block text-xs font-semibold uppercase tracking-widest text-dim">Confirm new password</span>
                <input type="password" value={credentials.confirmPassword} onChange={(event) => setCredentials((current) => ({ ...current, confirmPassword: event.target.value }))} autoComplete="new-password" className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-aurora-violet/60" placeholder="••••••••" />
              </label>}

              {resetMessage && <div role="status" className="rounded-xl border border-aurora-teal/40 bg-aurora-teal/10 px-4 py-3 text-sm text-teal-100">{resetMessage}</div>}

              {authError && (
                <div role="alert" className="rounded-xl border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                  {authError}
                </div>
              )}

              <button
                type="submit"
                disabled={loginLoading || (authMode === "forgot" ? !credentials.email.trim() : authMode === "reset" ? !credentials.password.trim() || !credentials.confirmPassword.trim() || !resetToken : !credentials.username.trim() || !credentials.password.trim() || (authMode === "register" && !credentials.email.trim()))}
                className="btn-aurora w-full inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3.5 text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loginLoading
                  ? authMode === "register" ? "Creating account…" : "Signing in…"
                  : authMode === "register" ? "Create account" : authMode === "forgot" ? "Send reset link" : authMode === "reset" ? "Reset password" : "Enter the studio"}
              </button>
            </form>
                {authMode === "login" && <button type="button" onClick={() => { setAuthError(""); setResetMessage(""); setAuthMode("forgot"); }} className="mt-4 w-full text-center text-xs font-semibold text-aurora-cyan hover:underline">Forgot your password?</button>}
                {(authMode === "forgot" || authMode === "reset") && <button type="button" onClick={() => { setAuthError(""); setResetMessage(""); setAuthMode("login"); }} className="mt-4 w-full text-center text-xs font-semibold text-dim hover:text-ink">Back to sign in</button>}
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
              {/* Dashboard / Studio / Playlists view switch */}
              <div className="flex items-center gap-1 rounded-full border border-white/10 bg-black/25 p-1" role="tablist" aria-label="Main views">
                {[
                  { key: "dashboard", label: "Dashboard", glyph: "◫" },
                  { key: "studio", label: "Studio", glyph: "◉" },
                  { key: "playlists", label: "Playlists", glyph: "📚" },
                ].map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={activeView === tab.key}
                    onClick={() => setActiveView(tab.key)}
                    className={`rounded-full px-3.5 py-1 text-xs font-semibold transition-all duration-300
                      ${activeView === tab.key
                        ? "bg-aurora-violet/30 text-white shadow-glow border border-aurora-violet/50"
                        : "text-dim hover:text-ink border border-transparent"}`}
                  >
                    <span className="mr-1" aria-hidden="true">{tab.glyph}</span>
                    {tab.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
                aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                className="rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs font-semibold text-dim transition-all hover:text-ink hover:border-aurora-cyan/50"
              >
                {theme === "dark" ? "☾" : "☀"}
              </button>
              {showLogoutConfirm ? (
                <div className="flex flex-col items-center gap-2 px-4 py-2 bg-white/[0.05] rounded-xl">
                  <p className="text-xs font-semibold text-dim">Are you sure you want to log out?</p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setShowLogoutConfirm(false)}
                      className="px-3 py-1 text-xs font-semibold text-dim border border-white/10 bg-white/[0.03] hover:text-ink hover:border-white/25"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleLogout}
                      className="btn-aurora px-3 py-1 text-xs font-semibold"
                    >
                      Yes, logout
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowLogoutConfirm(true)}
                  className="rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs font-semibold text-dim transition-all hover:text-ink hover:border-aurora-magenta/50"
                >
                  Log out
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="w-full max-w-5xl mx-auto px-4 sm:px-6 pb-16 flex-1 flex flex-col">
        {activeView === "dashboard" ? (
          /* ---------------- Dashboard ---------------- */
          <DashboardSection
            authToken={authToken}
            stats={dashboardStats}
            refreshKey={historyRefreshKey}
            onActivate={handleDashboardActivate}
            onOpenEpisode={openEpisodeById}
          />
        ) : activeView === "playlists" ? (
          /* ---------------- Playlists ---------------- */
          <PlaylistSection
            authToken={authToken}
            onOpenEpisode={openEpisodeById}
            refreshKey={historyRefreshKey}
          />
        ) : (
          /* ---------------- Studio ---------------- */
          <>
        {/* Hero */}
        <section className="pt-14 sm:pt-20 pb-10 sm:pb-14 text-center">
          <Reveal>
            <p className="text-[11px] font-semibold uppercase tracking-[0.4em] text-aurora-cyan">
              PDF · PPTX · DOCX · Markdown · Text · YouTube & URLs
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
              DocuCast reads the whole document or link — body text, tables, graphs, images,
              YouTube transcripts, and notes — and hands it to two hosts who actually talk about it.
            </p>
          </Reveal>
        </section>

        <main className="flex flex-col gap-8">
          <Reveal delay={80}>
            <UploadSection
              files={files}
              setFiles={setFiles}
              studio={studio}
              setStudio={setStudio}
              onGenerate={handleGenerate}
              loading={loading}
              loadingMessage={STAGE_LABELS[jobStage] || STAGE_LABELS.queued}
              stageIndex={jobPercent}
              stageCount={100}
              elapsedSeconds={elapsedSeconds}
              retryAfterSeconds={retryAfterSeconds}
              authToken={authToken}
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
                fileName={files[0]?.name}
                authToken={authToken}
                onRegenerate={handleRegenerate}
                onResynthesize={handleResynthesize}
                regenerating={regenerating}
              />
            )}
          </div>

          {/* Saved episodes */}
          <Reveal delay={80} id="episode-library-wrapper">
            <div id="episode-library">
            <HistorySection
              authToken={authToken}
              refreshKey={historyRefreshKey}
              onStats={setDashboardStats}
              onOpenEpisode={(episode) => {
                setResult(episode);
                if (resultRef.current) {
                  resultRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
                }
              }}
            />
            </div>
          </Reveal>

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
          </>
        )}
      </div>
    </div>
  );
}
