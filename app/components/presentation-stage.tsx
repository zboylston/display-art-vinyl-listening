"use client";

import type { CSSProperties, ReactNode } from "react";
import { vinylFolioCopy } from "../lib/vinyl-folio";
import type { DisplayArtwork, DisplaySnapshot, DisplayTrack } from "../lib/display-snapshot";

type PresentationStageProps = {
  snapshot: DisplaySnapshot;
  /** Optional overlay for the controller (transition pill, debug). */
  chrome?: ReactNode;
  onGalleryClick?: () => void;
  showCurationStatus?: boolean;
};

function identityKey(track: DisplayTrack) {
  return `${track.artist}|${track.title}`.toLowerCase();
}

function VinylFolio({ track, progress, screen, className }: {
  track: DisplayTrack;
  progress: NonNullable<DisplaySnapshot["vinylProgress"]>;
  screen: "album" | "art";
  className?: string;
}) {
  const folio = vinylFolioCopy(progress);
  return (
    <aside className={`vinyl-folio vinyl-folio--${screen}${className ? ` ${className}` : ""}`} aria-label={`Vinyl playback: ${folio.sequence}`}>
      <p className="vinyl-folio__label"><span />Vinyl</p>
      {screen === "art" && <p className="vinyl-folio__title">{track.title}</p>}
      <p className="vinyl-folio__sequence">{folio.sequence}</p>
    </aside>
  );
}

function GalleryMusicHeader({ track, vinyl }: {
  track: DisplayTrack;
  vinyl: NonNullable<DisplaySnapshot["vinylProgress"]> | null;
}) {
  if (vinyl) return <VinylFolio track={track} progress={vinyl} screen="art" />;
  return (
    <aside className="gallery-music" aria-label="Now playing">
      <p className="vinyl-folio__label"><span />Now playing</p>
      <p className="vinyl-folio__title">{track.title}</p>
      <p className="vinyl-folio__sequence">{track.artist}</p>
    </aside>
  );
}

function ArtCard({ art }: { art: DisplayArtwork }) {
  return (
    <aside className="art-card" aria-label="Artwork details">
      <h2>{art.title}</h2>
      <p className="art-card__artist">{art.artist}</p>
      <p className="art-card__meta">{art.date} · {art.museum}</p>
    </aside>
  );
}

function StageFrame({ children, className, style, onClick, "aria-label": ariaLabel }: {
  children: ReactNode;
  className: string;
  style?: CSSProperties;
  onClick?: () => void;
  "aria-label"?: string;
}) {
  return (
    <main className={className} style={style} onClick={onClick} aria-label={ariaLabel}>
      {children}
    </main>
  );
}

const stageStyle: CSSProperties = {
  width: "min(100vw, calc(100vh * 16 / 9))",
  height: "min(100vh, calc(100vw * 9 / 16))",
  minHeight: 0,
  margin: "auto",
  aspectRatio: "16 / 9",
};

/** Shared presentation stages for the phone controller and the TV display. */
export function PresentationStage({
  snapshot,
  chrome,
  onGalleryClick,
  showCurationStatus = true,
}: PresentationStageProps) {
  const track = snapshot.currentTrack;
  const art = snapshot.artwork;
  const vinyl = snapshot.listeningMode === "vinyl" && snapshot.vinylProgress && track
    ? snapshot.vinylProgress
    : null;

  if (!isStageAct(snapshot.act) || !track) {
    return (
      <StageFrame className="display-waiting">
        <p className="eyebrow">Needle & Frame</p>
        <h1>Waiting for music</h1>
        <p>{snapshot.status || "The controller has not presented a track yet."}</p>
        {chrome}
      </StageFrame>
    );
  }

  if (snapshot.act === "track" || snapshot.act === "handoff") {
    return (
      <StageFrame className={`track-screen${snapshot.act === "handoff" ? " is-handing-off" : ""}`}>
        {snapshot.act === "handoff" && art && (
          <div className="handoff-art" aria-hidden="true">
            <img className="handoff-backdrop" src={art.image} alt="" />
            <img className="handoff-image" src={art.image} alt="" />
          </div>
        )}
        <div className="frame" key={identityKey(track)}>
          <section className="album-panel">
            <div className="album-mat">
              <div
                className={`album-cover${track.albumCover ? "" : " is-missing"}`}
                style={{ backgroundImage: track.albumCover ? `url(${track.albumCover})` : undefined }}
                role="img"
                aria-label={track.albumCover ? `${track.album} album artwork` : "Album artwork unavailable"}
              >
                {!track.albumCover && <span>{track.album.slice(0, 1)}</span>}
              </div>
            </div>
          </section>
          <section className="now-playing">
            <p className="eyebrow now-label"><span />Now playing</p>
            <h1 className={`artist-name${track.artist.length > 20 ? " is-long" : ""}`}>{track.artist}</h1>
            <h2 className={`song-title${track.title.length > 26 ? " is-long" : ""}`}>{track.title}</h2>
            <div className="album-details">
              <p className="field-label">From the album</p>
              <p className="album-name">
                <em>{track.album}</em>
                <span className="release-year"> · {track.year}</span>
              </p>
            </div>
          </section>
          {vinyl && <VinylFolio track={track} progress={vinyl} screen="album" />}
          {showCurationStatus && snapshot.status && (
            <p className="curation-status" role="status"><span aria-hidden="true" />{snapshot.status}</p>
          )}
        </div>
        {chrome}
      </StageFrame>
    );
  }

  if (!art) {
    return (
      <StageFrame className="display-waiting">
        <p className="eyebrow">Needle & Frame</p>
        <h1>{track.title}</h1>
        <p>{track.artist}</p>
        <p>{snapshot.status || "Selecting artwork…"}</p>
        {chrome}
      </StageFrame>
    );
  }

  if (snapshot.act === "art" || snapshot.act === "art-fade") {
    return (
      <StageFrame
        className={`art-intro${snapshot.act === "art-fade" ? " is-info-fading" : ""}`}
        style={stageStyle}
      >
        <img className="art-image" style={{ position: "absolute", zIndex: 0, inset: "-3%", width: "106%", height: "106%", filter: "blur(26px) brightness(.38)", transform: "scale(1.06)" }} src={art.image} alt="" />
        <img className="art-image gallery-artwork" style={{ position: "absolute", zIndex: 1, inset: 0, objectFit: "cover" }} src={art.image} alt="" />
        <div className="art-overlay" style={{ zIndex: 2 }} />
        <section style={{ zIndex: 3 }}>
          <p className="eyebrow">Selected artwork</p>
          <h1 className={`art-title${art.title.length > 34 ? " is-long" : ""}`}><em>{art.title}</em></h1>
          <h2>{art.artist}</h2>
          <p>{art.date} · {art.museum}</p>
        </section>
        {vinyl && <VinylFolio track={track} progress={vinyl} screen="art" />}
        {chrome}
      </StageFrame>
    );
  }

  return (
    <StageFrame
      className={`gallery${snapshot.act === "return" ? " is-returning" : ""}`}
      style={stageStyle}
      onClick={onGalleryClick}
      aria-label={`${art.title} by ${art.artist}`}
    >
      <img className="art-image" style={{ position: "absolute", zIndex: 0, inset: "-3%", width: "106%", height: "106%", filter: "blur(26px) brightness(.38)", transform: "scale(1.06)" }} src={art.image} alt="" />
      <img className="art-image gallery-artwork" style={{ position: "absolute", zIndex: 1, inset: 0, objectFit: "cover" }} src={art.image} alt={`${art.title} by ${art.artist}`} />
      <div className="gallery-overlay" aria-hidden="true" />
      <header className="gallery-header">
        <ArtCard art={art} />
        <GalleryMusicHeader track={track} vinyl={vinyl} />
      </header>
      {chrome}
    </StageFrame>
  );
}

function isStageAct(act: DisplaySnapshot["act"]) {
  return act === "track" || act === "handoff" || act === "art" || act === "art-fade" || act === "gallery" || act === "return";
}

export function toDisplayTrack(track: DisplayTrack): DisplayTrack {
  return {
    artist: track.artist,
    title: track.title,
    album: track.album,
    year: track.year,
    ...(track.albumCover ? { albumCover: track.albumCover } : {}),
    ...(track.genre ? { genre: track.genre } : {}),
  };
}

export function toDisplayArtwork(art: DisplayArtwork): DisplayArtwork {
  return {
    ...(art.id ? { id: art.id } : {}),
    title: art.title,
    artist: art.artist,
    date: art.date,
    museum: art.museum,
    image: art.image,
    rationale: art.rationale,
  };
}
