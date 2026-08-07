import { useRef } from "react";

export default function UploadSection({
  file,
  setFile,
  onGenerate,
  loading,
  loadingMessage,
}) {
  const inputRef = useRef(null);

  const handleChange = (e) => {
    const selected = e.target.files?.[0] || null;
    if (selected && !selected.name.toLowerCase().endsWith(".pdf")) {
      // Browsers that honor `accept` won't reach this, but guard anyway.
      e.target.value = "";
      setFile(null);
      return;
    }
    setFile(selected);
  };

  const canGenerate = !!file && !loading;

  return (
    <section className="rounded-2xl bg-dcCard border border-white/5 p-5 sm:p-6 shadow-xl animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        {/* Dropzone-ish file picker */}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={loading}
          className="flex-1 flex items-center justify-center gap-3 rounded-xl border-2 border-dashed border-white/15 hover:border-dcAccent/60 bg-dcBg/40 px-5 py-6 text-sm text-dcMuted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="w-6 h-6 text-dcAccent"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.8}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 16V4m0 0L8 8m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2"
            />
          </svg>
          <span className="font-medium text-dcText">
            {file ? file.name : "Choose a PDF to upload"}
          </span>
          <span className="hidden sm:inline text-xs">.pdf &middot; max 10MB</span>
        </button>

        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          onChange={handleChange}
          className="hidden"
          disabled={loading}
        />

        <button
          type="button"
          onClick={onGenerate}
          disabled={!canGenerate}
          className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-dcAccent px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-dcAccent/20 transition-all hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
        >
          {loading ? (
            <>
              <Spinner />
              Working...
            </>
          ) : (
            <>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19 11a7 7 0 01-14 0m7 7V4m0 0L8 8m4-4l4 4"
                />
              </svg>
              Generate Podcast
            </>
          )}
        </button>
      </div>

      {file && !loading && (
        <p className="mt-3 text-xs text-dcMuted">
          Selected: <span className="text-dcText">{file.name}</span> &middot;{" "}
          {(file.size / (1024 * 1024)).toFixed(2)} MB
        </p>
      )}

      {loading && (
        <div className="mt-5 flex items-center gap-3 rounded-xl bg-dcBg/50 px-4 py-3 animate-fade-in">
          <Spinner />
          <div>
            <p className="text-sm font-medium text-dcText">{loadingMessage}</p>
            <p className="text-xs text-dcMuted mt-0.5">
              This can take up to ~90 seconds, especially on a cold start.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

function Spinner() {
  return (
    <svg
      className="w-5 h-5 text-dcAccent animate-spin-slow"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}
