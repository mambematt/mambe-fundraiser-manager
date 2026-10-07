export interface BannerData {
  ok: boolean;
  message: string;
  warnings?: string[];
}

/** Shows the outcome of a form action. */
export function ResultBanner({ result }: { result?: BannerData | null }) {
  if (!result?.message) return null;
  const tone = !result.ok ? "critical" : result.warnings?.length ? "warning" : "success";
  return (
    <s-banner tone={tone}>
      <s-paragraph>{result.message}</s-paragraph>
      {result.warnings?.map((w) => (
        <s-paragraph key={w}>{w}</s-paragraph>
      ))}
    </s-banner>
  );
}
