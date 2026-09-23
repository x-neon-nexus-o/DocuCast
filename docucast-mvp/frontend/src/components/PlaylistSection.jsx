import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "/api";

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function PlaylistSection({ authToken, onOpenEpisode, refreshKey }) {
  const [playlists, setPlaylists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedPlaylist, setSelectedPlaylist] = useState(null);
  const [currentTrackIndex, setCurrentTrackIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState("");
  const audioRef = useRef(null);

  const fetchPlaylists = useCallback(async () => {
    if (!authToken) return;
    try {
      setLoading(true);
      const { data } = await axios.get(`${API_URL}/playlists`, {
        headers: { Authorization: `Bearer ${authToken}` },
        timeout: 15_000,
      });
      setPlaylists(data.playlists || []);
    } catch (err) {
      setError(err?.response?.data?.detail || "Could not load playlists.");
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => {
    fetchPlaylists();
  }, [fetchPlaylists, refreshKey]);

  const loadPlaylistDetails = async (playlistId) => {
    try {
      setError("");
      const { data } = await axios.get(`${API_URL}/playlists/${playlistId}`, {
        headers: { Authorization: `Bearer ${authToken}` },
        timeout: 20_000,
      });
      setSelectedPlaylist(data);
      setCurrentTrackIndex(0);
      setIsPlaying(false);
    } catch (err) {
      setError(err?.response?.data?.detail || "Could not load playlist episodes.");
    }
  };

  const deletePlaylist = async (playlistId, e) => {
    e.stopPropagation();
    if (!window.confirm("Are you sure you want to delete this playlist?")) return;
    try {
      await axios.delete(`${API_URL}/playlists/${playlistId}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (selectedPlaylist?.id === playlistId) {
        setSelectedPlaylist(null);
      }
      fetchPlaylists();
    } catch (err) {
      setError(err?.response?.data?.detail || "Could not delete playlist.");
    }
  };

  const currentEpisode = selectedPlaylist?.episodes?.[currentTrackIndex];
  const audioSrc = currentEpisode?.audio_base64
    ? `data:${currentEpisode.audio_mime || "audio/mpeg"};base64,${currentEpisode.audio_base64}`
    : null;

  // Handle continuous playback when a track finishes
  const handleTrackEnded = () => {
    if (selectedPlaylist?.episodes && currentTrackIndex + 1 < selectedPlaylist.episodes.length) {
      setCurrentTrackIndex((idx) => idx + 1);
      setTimeout(() => {
        if (audioRef.current) {
          audioRef.current.play().catch(() => {});
          setIsPlaying(true);
        }
      }, 300);
    } else {
      setIsPlaying(false);
    }
  };

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().catch(() => {});
      setIsPlaying(true);
    }
  };

  const nextTrack = () => {
    if (selectedPlaylist?.episodes && currentTrackIndex + 1 < selectedPlaylist.episodes.length) {
      setCurrentTrackIndex((idx) => idx + 1);
    }
  };

  const prevTrack = () => {
    if (currentTrackIndex > 0) {
      setCurrentTrackIndex((idx) => idx - 1);
    }
  };

  return (
    <div className="flex flex-col gap-6 animate-fade-up">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-aurora-cyan">Batch Mode & Playlists</p>
          <h2 className="font-display text-giant font-semibold mt-1">
            Your <span className="text-aurora">series & playlists</span>
          </h2>
          <p className="text-xs text-dim mt-1">
            Group multi-part lecture series, course modules, or articles with continuous autoplay.
          </p>
        </div>
        <button
          type="button"
          onClick={fetchPlaylists}
          className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 text-xs font-semibold text-dim hover:text-ink hover:border-aurora-violet/50 transition-colors"
        >
          ↻ Refresh
        </button>
      </div>

      {error && (
        <div role="alert" className="rounded-xl border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {/* Main Content Area */}
      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr] items-start">
        {/* Left: Playlists List */}
        <section className="glass rounded-[1.75rem] p-5 sm:p-6">
          <h3 className="font-display text-base font-semibold text-ink mb-4 flex items-center gap-2">
            <span>◫</span> Playlists ({playlists.length})
          </h3>

          {loading ? (
            <div className="p-8 text-center text-sm text-dim animate-pulse">Loading playlists…</div>
          ) : playlists.length === 0 ? (
            <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-8 text-center text-dim">
              <p className="text-2xl mb-2">📚</p>
              <p className="font-medium text-ink text-sm">No playlists yet</p>
              <p className="text-xs mt-1 max-w-sm mx-auto">
                Head to the Studio and switch to "Batch Series / Playlist" to drop a lecture series or queue multiple links!
              </p>
            </div>
          ) : (
            <div className="grid gap-3">
              {playlists.map((pl) => {
                const isSelected = selectedPlaylist?.id === pl.id;
                return (
                  <div
                    key={pl.id}
                    onClick={() => loadPlaylistDetails(pl.id)}
                    className={`group cursor-pointer rounded-2xl p-4 transition-all duration-300 border text-left ${
                      isSelected
                        ? "bg-aurora-violet/20 border-aurora-violet/60 shadow-glow"
                        : "border-white/5 bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/20"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h4 className="font-display font-semibold text-sm text-ink group-hover:text-aurora-cyan transition-colors">
                          {pl.title}
                        </h4>
                        {pl.description && (
                          <p className="text-xs text-dim mt-0.5 line-clamp-1">{pl.description}</p>
                        )}
                        <div className="flex items-center gap-3 text-[11px] text-faint mt-2">
                          <span className="text-aurora-teal font-semibold">
                            {pl.episode_count} episode{pl.episode_count === 1 ? "" : "s"}
                          </span>
                          <span>·</span>
                          <span>{new Date(pl.created_at * 1000).toLocaleDateString()}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={(e) => deletePlaylist(pl.id, e)}
                          title="Delete playlist"
                          className="rounded-lg p-1.5 text-xs text-dim opacity-40 hover:opacity-100 hover:text-red-300 hover:bg-red-500/10 transition-all"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Right: Active Playlist Player */}
        <section className="glass-deep rounded-[1.75rem] p-5 sm:p-6 sticky top-20">
          {selectedPlaylist ? (
            <div>
              <div className="border-b border-white/10 pb-4 mb-4">
                <span className="text-[10px] font-bold uppercase tracking-widest text-aurora-cyan">Now Playing Series</span>
                <h3 className="font-display text-xl font-bold text-ink mt-1">{selectedPlaylist.title}</h3>
                {selectedPlaylist.description && (
                  <p className="text-xs text-dim mt-1">{selectedPlaylist.description}</p>
                )}
              </div>

              {/* Player UI */}
              {audioSrc ? (
                <div className="rounded-2xl border border-white/10 bg-black/40 p-4 mb-5">
                  <audio
                    ref={audioRef}
                    src={audioSrc}
                    onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime || 0)}
                    onLoadedMetadata={() => setDuration(audioRef.current?.duration || 0)}
                    onEnded={handleTrackEnded}
                  />

                  <div className="flex items-center justify-between gap-3 text-xs mb-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] font-semibold text-aurora-violet">
                        Episode {currentTrackIndex + 1} of {selectedPlaylist.episodes?.length || 1}
                      </p>
                      <p className="font-medium text-ink text-sm truncate mt-0.5">
                        {currentEpisode?.filename || "Untitled Episode"}
                      </p>
                    </div>

                    {currentEpisode?.id && (
                      <button
                        type="button"
                        onClick={() => onOpenEpisode(currentEpisode.id)}
                        className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-semibold text-dim hover:text-ink hover:border-aurora-cyan/40 transition-colors"
                      >
                        View script ↗
                      </button>
                    )}
                  </div>

                  {/* Playhead bar */}
                  <div className="flex items-center gap-3 text-[11px] font-mono text-dim mb-4">
                    <span>{formatDuration(currentTime)}</span>
                    <div
                      className="flex-1 h-1.5 bg-white/10 rounded-full cursor-pointer relative overflow-hidden"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const pos = (e.clientX - rect.left) / rect.width;
                        if (audioRef.current && duration) {
                          audioRef.current.currentTime = pos * duration;
                        }
                      }}
                    >
                      <div
                        className="h-full bg-gradient-to-r from-aurora-violet to-aurora-cyan rounded-full"
                        style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
                      />
                    </div>
                    <span>{formatDuration(duration)}</span>
                  </div>

                  {/* Playback Controls */}
                  <div className="flex items-center justify-center gap-4">
                    <button
                      type="button"
                      onClick={prevTrack}
                      disabled={currentTrackIndex === 0}
                      className="p-2 text-dim hover:text-ink disabled:opacity-30 transition-colors"
                      title="Previous episode"
                    >
                      ⏮
                    </button>

                    <button
                      type="button"
                      onClick={togglePlay}
                      className="btn-aurora h-12 w-12 rounded-full grid place-items-center text-lg text-white shadow-glow"
                    >
                      {isPlaying ? "❚❚" : "▶"}
                    </button>

                    <button
                      type="button"
                      onClick={nextTrack}
                      disabled={!selectedPlaylist.episodes || currentTrackIndex >= selectedPlaylist.episodes.length - 1}
                      className="p-2 text-dim hover:text-ink disabled:opacity-30 transition-colors"
                      title="Next episode"
                    >
                      ⏭
                    </button>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 text-center text-xs text-dim mb-4">
                  Select an episode below to play
                </div>
              )}

              {/* Track Queue */}
              <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1 script-scroll">
                <p className="text-[10px] font-bold uppercase tracking-widest text-dim mb-2">Episodes In This Series</p>
                {selectedPlaylist.episodes?.map((ep, idx) => {
                  const isCurrent = idx === currentTrackIndex;
                  return (
                    <div
                      key={ep.id || idx}
                      onClick={() => {
                        setCurrentTrackIndex(idx);
                        setIsPlaying(true);
                        setTimeout(() => {
                          if (audioRef.current) audioRef.current.play().catch(() => {});
                        }, 100);
                      }}
                      className={`flex items-center justify-between gap-3 p-2.5 rounded-xl cursor-pointer text-xs transition-colors ${
                        isCurrent
                          ? "bg-aurora-cyan/15 border border-aurora-cyan/40 text-cyan-100 font-semibold"
                          : "hover:bg-white/[0.04] text-dim hover:text-ink border border-transparent"
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="font-mono text-[10px] text-faint w-4 text-right">
                          {isCurrent && isPlaying ? "▶" : idx + 1}
                        </span>
                        <span className="truncate">{ep.filename || "Episode " + (idx + 1)}</span>
                      </div>
                      <span className="text-[10px] uppercase font-mono text-faint shrink-0">
                        {ep.options?.mode || "dialogue"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="p-8 text-center text-dim">
              <p className="text-3xl mb-2">📻</p>
              <p className="font-semibold text-ink text-sm">No series selected</p>
              <p className="text-xs mt-1">Select a playlist on the left to start continuous playback.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
