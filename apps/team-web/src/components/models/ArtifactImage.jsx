import { useArtifactQuery } from "../../api/queries.js";
import { workbenchApi } from "../../api/client.js";

export function ArtifactImage({ artifactId, alt = "Generated image", className = "", testId }) {
  const artifact = useArtifactQuery(artifactId, Boolean(artifactId));
  const metadata = artifact.data?.data;
  if (artifact.isLoading) return <div className={`artifactImagePlaceholder ${className}`} role="status">…</div>;
  if (artifact.error || metadata?.state !== "ready") {
    return <div className={`artifactImagePlaceholder error ${className}`} role="status">{artifact.error?.message || "Image unavailable"}</div>;
  }
  return (
    <figure className={`artifactImage ${className}`} data-testid={testId}>
      <img
        src={workbenchApi.artifactContentUrl(artifactId)}
        alt={alt}
        width={metadata.dimensions?.width}
        height={metadata.dimensions?.height}
        loading="lazy"
      />
      <figcaption>{metadata.dimensions?.width} × {metadata.dimensions?.height} · {metadata.mediaType}</figcaption>
    </figure>
  );
}
