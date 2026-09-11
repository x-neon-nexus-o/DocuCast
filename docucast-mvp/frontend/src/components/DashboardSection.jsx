import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { Reveal } from "../App.jsx";

const API_URL = import.meta.env.VITE_API_URL || "/api";

/* ------------------------------------------------------------------ */
/* Count-up number — animates from 0 to the target when it mounts       */
/* ------------------------------------------------------------------ */
function CountUp({ value, duration = 900 }) {
  const [display, setDisplay] = useState(0);
  const rafRef = useRef(0);

  useEffect(() => {
    const start = performance.now();
    const from = 0;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      // easeOutCubic for a satisfying settle
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (value - from) * eased));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, duration]);

  return <span className="tabular-nums">{display.toLocaleString()}</span>;
}

/* ------------------------------------------------------------------ */
/* Stat card — glow sweep on hover, staggered entrance                  */
/* ------------------------------------------------------------------ */
const STAT_CARDS = (stats) => [
  {
    label: "Episodes",
    value: stats?.total ?? 0,
    hint: stats?.total === 1 ? "episode in your library" : "episodes in your library",
    glyph: "◉",
    accent: "stat-violet",
  },
  {
    label: "This week",
    value: stats?.last_7d ?? 0,
    hint: "created in the last 7 days",
    glyph: "✦",
    accent: "stat-cyan",
  },
  {
    label: "With audio",
    value: stats?.with_audio ?? 0,
    hint: "ready to play & download",
    glyph: "⇩",
    accent: "stat-teal",
  },
  {
    label: "Formats",
    value: Object.keys(stats?.doc_types || {}).length,
    hint: "different document types used",
    glyph: "◫",
    accent: "stat-magenta",
  },
];

/* ------------------------------------------------------------------ */
/* Quick actions — buttons with sweeping glow + pressable feel          */
/* ------------------------------------------------------------------ */
const QUICK_ACTIONS = [
  {
    key: "new",
    glyph: "⇪",
    title: "Create a podcast",
    body: "Upload a PDF, deck, Word doc, markdown or notes.",
    cta: "Open the studio",
  },
  {
    key: "recent",
    glyph: "↻",
    title: "Pick up where you left off",
    body: "Replay or re-tune any episode from your library.",
    cta: "Browse library",
  },
  {
    key: "tune",
    glyph: "◎",
    title: "Direct the show",
    body: "Two hosts or solo, calm or energetic, brief or deep — with focus steering.",
    cta: "Studio controls",
  },
];

function QuickActionCard({ action, onActivate, delay }) {
  return (
    <Reveal delay={delay}>
      <button
        type="button"
        onClick={() => onActivate(action.key)}
        className="dash-card glass glass-hover group relative w-full overflow-hidden rounded-2xl p-5 text-left transition-transform duration-300 hover:-translate-y-1 active:translate-y-0 active:scale-[0.98]"
      >
        {/* sweeping glow on hover */}
        <span className="dash-sheen" aria-hidden="true" />
        <span className="text-2xl text-aurora-violet transition-transform duration-300 group-hover:scale-110 group-hover:rotate-6" aria-hidden="true">
          {action.glyph}
        </span>
        <h3 className="mt-3 font-display text-base font-semibold">{action.title}</h3>
        <p className="mt-2 text-sm text-dim leading-relaxed">{action.body}</p>
        <span className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-aurora-cyan transition-all duration-300 group-hover:gap-2.5">
          {action.cta}
          <span aria-hidden="true" className="transition-transform duration-300 group-hover:translate-x-1">→</span>
        </span>
      </button>
    </Reveal>
  );
}

/* ------------------------------------------------------------------ */
/* Dashboard section                                                   */
/* ------------------------------------------------------------------ */
export default function DashboardSection({
  authToken,
  stats,
  onActivate,
  onOpenEpisode,
  refreshKey,
}) {
  const [recent, setRecent] = useState(null);
  const [providers, setProviders] = useState(null);

  // Recent episodes (light list, no audio) — reuses /episodes.
  useEffect(() => {
    let isActive = true;
    setRecent(null);
    axios
      .get(`${API_URL}/episodes?limit=5`, {
        headers: { Authorization: `Bearer ${authToken}` },
        timeout: 15_000,
      })
      .then(({ data }) => {
        if (isActive) setRecent(data.episodes || []);
      })
      .catch(() => {
        if (isActive) setRecent([]);
      });
    return () => {
      isActive = false;
    };
  }, [authToken, refreshKey]);

  // Provider health (public endpoint) — powers the "engine room" strip.
  useEffect(() => {
    let isActive = true;
    axios
      .get(`${API_URL}/providers`, { timeout: 10_000 })
      .then(({ data }) => {
        if (isActive) setProviders(data.providers || {});
      })
      .catch(() => {
        if (isActive) setProviders({});
      });
    return () => {
      isActive = false;
    };
  }, []);

  return (
    <div className="flex flex-col gap-8">
      {/* Greeting */}
      <section className="pt-4 sm:pt-8 text-center">
        <Reveal>
          <p className="text-[11px] font-semibold uppercase tracking-[0.4em] text-aurora-cyan">
            Studio overview
          </p>
        </Reveal>
        <Reveal delay={90}>
          <h1 className="mt-4 font-display text-giant font-bold">
            Your podcast <span className="text-aurora text-aurora--animated">at a glance.</span>
          </h1>
        </Reveal>
      </section>

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STAT_CARDS(stats).map((card, i) => (
          <Reveal key={card.label} delay={i * 90}>
            <div className={`dash-card glass glass-hover stat-card stat-card--${card.accent} group relative overflow-hidden rounded-2xl p-5`}>
              <span className="dash-sheen" aria-hidden="true" />
              <div className="flex items-start justify-between">
                <span className="text-xl opacity-80 transition-transform duration-300 group-hover:scale-110" aria-hidden="true">
                  {card.glyph}
                </span>
                <span className="stat-dot" aria-hidden="true" />
              </div>
              <p className="mt-3 font-display text-4xl font-bold">
                <CountUp value={card.value} />
              </p>
              <p className="mt-1 text-xs font-semibold uppercase tracking-widest text-dim">{card.label}</p>
              <p className="mt-1.5 text-[11px] text-faint leading-relaxed">{card.hint}</p>
            </div>
          </Reveal>
        ))}
      </div>

      {/* Quick actions */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {QUICK_ACTIONS.map((action, i) => (
          <QuickActionCard key={action.key} action={action} onActivate={onActivate} delay={i * 90} />
        ))}
      </div>

      {/* Recent episodes + engine room */}
      <div className="grid gap-4 lg:grid-cols-[1.4fr_0.6fr]">
        <Reveal>
          <section aria-labelledby="dash-recent" className="glass rounded-[1.75rem] p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <h3 id="dash-recent" className="font-display text-lg font-semibold">
                Recent <span className="text-aurora">episodes</span>
              </h3>
              <button
                type="button"
                onClick={() => onActivate("recent")}
                className="rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-[11px] font-semibold text-dim transition-all hover:-translate-y-0.5 hover:text-ink hover:border-aurora-violet/50"
              >
                View all →
              </button>
            </div>

            {recent === null ? (
              <div className="mt-4 grid gap-2.5">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="dash-skeleton h-14 rounded-xl" />
                ))}
              </div>
            ) : recent.length === 0 ? (
              <div className="mt-5 flex flex-col items-center gap-3 py-6 text-center">
                <span className="text-3xl text-aurora-violet animate-float" aria-hidden="true">⇪</span>
                <p className="text-sm text-dim">No episodes yet — your first podcast is one upload away.</p>
                <button
                  type="button"
                  onClick={() => onActivate("new")}
                  className="btn-aurora rounded-full px-5 py-2 text-xs font-semibold text-white transition-transform duration-200 hover:-translate-y-0.5 active:translate-y-0"
                >
                  ◉ Create your first episode
                </button>
              </div>
            ) : (
              <div className="panel-scroll mt-4 grid gap-2.5 max-h-72 overflow-y-auto pr-1">
                {recent.map((ep, i) => (
                  <button
                    key={ep.id}
                    type="button"
                    onClick={() => onOpenEpisode(ep.id)}
                    className="group flex items-center gap-3 rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-aurora-violet/40 hover:shadow-glow"
                    style={{ animationDelay: `${i * 60}ms` }}
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-aurora-violet/40 bg-aurora-violet/10 text-sm text-violet-200 transition-transform duration-300 group-hover:scale-110" aria-hidden="true">
                      ▶
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-ink">{ep.filename || "document"}</p>
                      <p className="mt-0.5 text-[11px] text-dim">
                        {ep.options?.mode === "solo" ? "solo" : "two hosts"} · {ep.provider}
                        {ep.audio_engine ? ` · ${ep.audio_engine}` : ""}
                      </p>
                    </div>
                    <span
                      className="text-dim opacity-0 transition-all duration-300 group-hover:translate-x-1 group-hover:opacity-100"
                      aria-hidden="true"
                    >
                      →
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </Reveal>

        {/* Engine room — live provider status */}
        <Reveal delay={90}>
          <section aria-labelledby="dash-engines" className="glass rounded-[1.75rem] p-5 sm:p-6 h-full">
            <h3 id="dash-engines" className="font-display text-lg font-semibold">
              Engine <span className="text-aurora">room</span>
            </h3>
            <p className="mt-1.5 text-xs text-dim">Live status of the generation stack.</p>
            <ul className="mt-4 grid gap-2.5">
              {[
                ["Gemini", providers?.gemini],
                ["Groq", providers?.groq],
                ["OpenRouter", providers?.openrouter],
                ["Ollama", providers?.ollama],
                ["Local fallback", providers?.local ?? true],
              ].map(([name, on]) => (
                <li
                  key={name}
                  className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/25 px-3.5 py-2.5"
                >
                  <span className="text-xs font-semibold text-ink">{name}</span>
                  <span className={`engine-pill ${on ? "engine-pill--on" : ""}`}>
                    <span className="engine-dot" aria-hidden="true" />
                    {on ? "ready" : "off"}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-[11px] text-faint leading-relaxed">
              Fallbacks chain automatically — if a provider hits its cap, the next
              one takes over, ending at the offline local engine.
            </p>
          </section>
        </Reveal>
      </div>
    </div>
  );
}
