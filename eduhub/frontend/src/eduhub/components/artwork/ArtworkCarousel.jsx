/**
 * ArtworkCarousel.jsx — swipeable, auto-sliding artwork carousel.
 *
 * Used for Dashboard Hero and Library Hero placements. Features:
 *   • Swipeable (embla-carousel-react, already a project dependency)
 *   • Auto-slide every ~6s, looped
 *   • Pauses on interaction (pointer down / hover) and resumes after
 *   • Clickable slides (resolves each campaign's click_action)
 *   • Renders nothing when there are no live campaigns (fully additive)
 *
 * Single-campaign mode renders a static frame (no dots, no autoplay).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { useNavigate } from "react-router-dom";
import useArtworkCampaigns from "./useArtworkCampaigns";
import useArtworkTopUp from "./useArtworkTopUp";
import { makeArtworkClickHandler } from "./artworkClickAction";
import ArtworkImage from "./ArtworkImage";
import "./artwork.css";

const AUTOPLAY_MS = 6000;

export default function ArtworkCarousel({
  placement,
  className = "",
  showCaption = false,
  fallback = null,
  testid,
}) {
  const { campaigns } = useArtworkCampaigns(placement);
  const navigate = useNavigate();
  const { openTopUp, topUpNode } = useArtworkTopUp();
  const [selected, setSelected] = useState(0);

  const multi = campaigns.length > 1;
  const [emblaRef, emblaApi] = useEmblaCarousel({
    loop: true,
    align: "center",
    active: multi,
  });

  const timerRef = useRef(null);
  const pausedRef = useRef(false);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const play = useCallback(() => {
    stop();
    if (!emblaApi || !multi) return;
    timerRef.current = setInterval(() => {
      if (!pausedRef.current && emblaApi) emblaApi.scrollNext();
    }, AUTOPLAY_MS);
  }, [emblaApi, multi, stop]);

  useEffect(() => {
    if (!emblaApi) return;
    const onSelect = () => setSelected(emblaApi.selectedScrollSnap());
    emblaApi.on("select", onSelect);
    onSelect();
    return () => emblaApi.off("select", onSelect);
  }, [emblaApi]);

  useEffect(() => {
    play();
    return stop;
  }, [play, stop]);

  if (!campaigns.length) {
    // No live campaigns: show fallback immediately (no blank space, no layout jump).
    // With cache, campaigns are populated on the first render so this branch is
    // only reached on a cold first load or when no campaign is active.
    // Library placements pass no fallback prop, so they collapse to null cleanly.
    return fallback || null;
  }

  const pause = () => {
    pausedRef.current = true;
  };
  const resume = () => {
    pausedRef.current = false;
  };

  const renderSlide = (c) => (
    <ArtworkImage
      key={c.id}
      campaign={c}
      placement={placement}
      scrim={showCaption}
      caption={showCaption ? c.name : null}
      onClick={makeArtworkClickHandler(c, { navigate, openTopUp })}
      testid={`artwork-slide-${placement}`}
    />
  );

  // Single campaign → static frame (no carousel chrome)
  if (!multi) {
    return (
      <div className={`artwork-carousel ${className}`} data-testid={testid || `artwork-carousel-${placement}`}>
        {renderSlide(campaigns[0])}
        {topUpNode}
      </div>
    );
  }

  return (
    <div
      className={`artwork-carousel ${className}`}
      data-testid={testid || `artwork-carousel-${placement}`}
      onMouseEnter={pause}
      onMouseLeave={resume}
      onPointerDown={pause}
      onPointerUp={resume}
    >
      <div className="artwork-embla" ref={emblaRef}>
        <div className="artwork-embla__container">
          {campaigns.map((c) => (
            <div className="artwork-embla__slide" key={c.id}>
              {renderSlide(c)}
            </div>
          ))}
        </div>
      </div>

      <div className="artwork-dots" data-testid={`artwork-dots-${placement}`}>
        {campaigns.map((c, i) => (
          <button
            key={c.id}
            type="button"
            className="artwork-dot"
            data-active={i === selected ? "true" : "false"}
            aria-label={`Go to slide ${i + 1}`}
            onClick={() => emblaApi && emblaApi.scrollTo(i)}
          />
        ))}
      </div>

      {topUpNode}
    </div>
  );
}
