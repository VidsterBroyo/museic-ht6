type LoadingVariant = "app" | "feed" | "profile" | "default";

const TIPS: Record<LoadingVariant, string> = {
  app: "Warming up Museic and checking your session.",
  feed: "Fetching songs, album art, and the first reaction graph.",
  profile: "Building your profile from moments your body reacted to.",
  default: "Preparing the next view.",
};

export default function LoadingState({
  title,
  variant = "default",
}: {
  title: string;
  variant?: LoadingVariant;
}) {
  return (
    <div className={`loading-state loading-${variant}`} role="status" aria-live="polite">
      <div className="loading-throbber" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <h2>{title}</h2>
      <p className="muted">{TIPS[variant]}</p>
      <Skeleton variant={variant} />
    </div>
  );
}

function Skeleton({ variant }: { variant: LoadingVariant }) {
  if (variant === "feed") {
    return (
      <div className="loading-skeleton loading-skeleton-feed" aria-hidden="true">
        <div className="skeleton-disc" />
        <div className="skeleton-line wide" />
        <div className="skeleton-line medium" />
        <div className="skeleton-pill-row">
          <div className="skeleton-pill" />
          <div className="skeleton-pill" />
          <div className="skeleton-pill" />
        </div>
      </div>
    );
  }

  if (variant === "profile") {
    return (
      <div className="loading-skeleton loading-skeleton-profile" aria-hidden="true">
        <div className="skeleton-line wide" />
        <div className="skeleton-line full" />
        <div className="skeleton-line full" />
        <div className="skeleton-card-grid">
          <div />
          <div />
          <div />
        </div>
      </div>
    );
  }

  return (
    <div className="loading-skeleton" aria-hidden="true">
      <div className="skeleton-line wide" />
      <div className="skeleton-line medium" />
    </div>
  );
}
