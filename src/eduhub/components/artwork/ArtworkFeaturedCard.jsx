/**
 * ArtworkFeaturedCard.jsx — Library "Featured Collection" placement (B).
 *
 * Sits between Continue Reading and My Books. Shows the single highest-
 * priority live campaign for the `library_featured` placement as a wide
 * 21:9 curated-recommendation card. Renders nothing when none are live.
 */
import { useNavigate } from "react-router-dom";
import useArtworkCampaigns from "./useArtworkCampaigns";
import useArtworkTopUp from "./useArtworkTopUp";
import { makeArtworkClickHandler } from "./artworkClickAction";
import ArtworkImage from "./ArtworkImage";
import "./artwork.css";

export default function ArtworkFeaturedCard({ className = "" }) {
  const { campaigns } = useArtworkCampaigns("library_featured");
  const navigate = useNavigate();
  const { openTopUp, topUpNode } = useArtworkTopUp();

  if (!campaigns.length) return null;
  const c = campaigns[0]; // already sorted by priority desc on the server

  return (
    <div className={`mt-4 ${className}`} data-testid="artwork-featured-collection">
      <ArtworkImage
        campaign={c}
        placement="library_featured"
        scrim
        caption={c.name}
        onClick={makeArtworkClickHandler(c, { navigate, openTopUp })}
        testid="artwork-featured-frame"
      />
      {topUpNode}
    </div>
  );
}
