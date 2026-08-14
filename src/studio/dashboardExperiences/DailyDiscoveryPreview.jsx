/**
 * DailyDiscoveryPreview.jsx — Dashboard Studio › Today's Discovery preview.
 *
 * Renders the REAL student-facing DiscoveryCard component with the draft
 * config passed straight through — never a mock/re-implemented preview.
 * DiscoveryCard's `previewConfig` prop exists specifically for this call
 * site (see its own header comment); Dashboard.jsx never passes it.
 */
import DiscoveryCard from "../../eduhub/components/dashboard/DiscoveryCard";

export default function DailyDiscoveryPreview({ config }) {
  return (
    <div
      className="rounded-2xl overflow-hidden border border-white/10"
      style={{ background: "#fafafa", maxWidth: 380 }}
      data-testid="daily-discovery-preview-frame"
    >
      <DiscoveryCard previewConfig={config} />
    </div>
  );
}
