import { useMemo, useState } from "react";

export default function ResultSection({ script, audioBase64, audioError, fileName, provider, providerNote }) {
  const [feedback, setFeedback] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const audioSrc = useMemo(() => {
    if (!audioBase64) return null;
    return `data:audio/mp3;base64,${audioBase64}`;
  }, [audioBase64]);

  const downloadName = useMemo(() => {
    const base = (fileName || "document").replace(/\.pdf$/i, "");
    return `${base}-docucast.mp3`;
  }, [fileName]);

  const handleDownload = () => {
    if (!audioSrc) return;
    const link = document.createElement("a");
    link.href = audioSrc;
    link.download = downloadName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleFeedbackSubmit = (e) => {
    e.preventDefault();
    // Client-side only: no backend storage in the MVP.
    setSubmitted(true);
  };

  return (
    <section className="rounded-2xl bg-dcCard border border-white/5 p-5 sm:p-6 shadow-xl flex flex-col gap-5 animate-fade-in">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-semibold">Your Podcast Script</h2>
        <div className="flex items-center gap-2">
          {provider && (
            <span
              className={`text-[11px] font-semibold px-2 py-1 rounded-full border ${
                provider === "local"
                  ? "bg-yellow-500/15 border-yellow-500/30 text-yellow-300"
                  : provider === "gemini"
                    ? "bg-blue-500/15 border-blue-500/30 text-blue-300"
                    : "bg-emerald-500/15 border-emerald-500/30 text-emerald-300"
              }`}
            >
              {provider === "local" ? "⚡ Local (unlimited)" : provider === "gemini" ? "✦ Gemini" : `✓ ${provider}`}
            </span>
          )}
          <span className="text-xs text-dcMuted">{script.trim().split(/\s+/).length} words</span>
        </div>
      </div>

      {providerNote && (
        <div
          className={`rounded-xl px-3 py-2 text-xs leading-relaxed border ${
            provider === "local"
              ? "bg-yellow-500/10 border-yellow-500/20 text-yellow-200"
              : "bg-emerald-500/10 border-emerald-500/20 text-emerald-200"
          }`}
        >
          {providerNote}
        </div>
      )}

      {/* Script card */}
      <div className="script-scroll max-h-72 overflow-y-auto rounded-xl bg-dcBg/60 border border-white/5 p-4 text-sm leading-relaxed whitespace-pre-wrap text-dcText/90">
        {script}
      </div>

      {/* Audio */}
      {audioSrc ? (
        <div className="flex flex-col gap-3">
          <audio controls preload="none" src={audioSrc}>
            Your browser does not support the audio element.
          </audio>
          <button
            type="button"
            onClick={handleDownload}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-dcAccent/60 bg-dcAccent/10 px-4 py-2.5 text-sm font-semibold text-dcAccent transition-colors hover:bg-dcAccent/20"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3"
              />
            </svg>
            Download MP3
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-200">
          <p className="font-medium">Audio unavailable</p>
          <p className="mt-1 text-yellow-200/80">
            {audioError ||
              "The script was generated, but audio synthesis failed. You can still read the script above."}
          </p>
        </div>
      )}

      {/* Feedback (client-side only) */}
      <div className="border-t border-white/5 pt-4">
        {submitted ? (
          <p className="text-sm text-dcMuted">
            Thanks for the feedback! (Stored locally in your browser only.)
          </p>
        ) : (
          <form onSubmit={handleFeedbackSubmit} className="flex flex-col gap-2">
            <label
              htmlFor="feedback"
              className="text-xs font-medium text-dcMuted uppercase tracking-wide"
            >
              Feedback (optional)
            </label>
            <textarea
              id="feedback"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={2}
              placeholder="How was the result? (This stays in your browser — nothing is sent.)"
              className="w-full rounded-lg bg-dcBg/60 border border-white/10 px-3 py-2 text-sm text-dcText placeholder:text-dcMuted/60 focus:outline-none focus:ring-2 focus:ring-dcAccent/60 focus:border-transparent resize-none"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={!feedback.trim()}
                className="text-xs font-semibold text-dcAccent hover:text-blue-400 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Submit feedback
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
