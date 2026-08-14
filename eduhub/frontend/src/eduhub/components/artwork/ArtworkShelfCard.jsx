/**
 * ArtworkShelfCard.jsx — Library "Shelf Artwork Card" placement (C).
 *
 * A single book-card-sized (2:3) artwork tile that can be dropped INSIDE a
 * bookshelf row. The Library injects at most one per 10–12 books and never
 * as a large banner. Renders nothing when no `library_shelf` campaign is
 * live. The `index` prop picks which live campaign to show so repeated
 * injections rotate through available shelf artworks.
 */
import { useNavigate } from "react-router-dom";
import useArtworkCampaigns from "./useArtworkCampaigns";
import useArtworkTopUp from "./useArtworkTopUp";
import { makeArtworkClickHandler } from "./artworkClickAction";
import ArtworkImage from "./ArtworkImage";
import "./artwork.css";

export default function ArtworkShelfCard({ index = 0, className = "" }) {
  const { campaigns } = useArtworkCampaigns("library_shelf");
  const navigate = useNavigate();
  const { openTopUp, topUpNode } = useArtworkTopUp();

  if (!campaigns.length) return null;
  const c = campaigns[index % campaigns.length];

  return (
    <div className={`artwork-shelf-card ${className}`} data-testid="artwork-shelf-card">
      <ArtworkImage
        campaign={c}
        placement="library_shelf"
        onClick={makeArtworkClickHandler(c, { navigate, openTopUp })}
        testid="artwork-shelf-frame"
      />
      <span className="artwork-shelf-badge">Featured</span>
      <div className="artwork-shelf-title">{c.name}</div>
      {topUpNode}
    </div>
  );
}
