import { useEffect, useRef } from "react";
import { useFetcher } from "react-router";

/**
 * Asks the page's action for a CSV (intent + fields) and downloads it in the
 * browser. If the browser blocks the download inside Shopify admin, the CSV
 * text is shown to copy instead.
 */
export function CsvDownload({
  intent,
  fields = {},
  filename,
  label,
  disabled,
}: {
  intent: string;
  fields?: Record<string, string | string[]>;
  filename: string;
  label: string;
  disabled?: boolean;
}) {
  const fetcher = useFetcher<{ csv?: string; message?: string; ok?: boolean }>();
  const done = useRef<string | null>(null);
  const csv = fetcher.data?.csv;

  useEffect(() => {
    if (!csv || done.current === csv) return;
    done.current = csv;
    try {
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch {
      // The text area below is the fallback.
    }
  }, [csv, filename]);

  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value={intent} />
      {Object.entries(fields).flatMap(([k, v]) =>
        (Array.isArray(v) ? v : [v]).map((value) => <input key={`${k}=${value}`} type="hidden" name={k} value={value} />),
      )}
      <s-stack gap="small">
        <s-button type="submit" disabled={disabled || fetcher.state !== "idle"}>{label}</s-button>
        {fetcher.data && !fetcher.data.csv && fetcher.data.message && <s-text tone="critical">{fetcher.data.message}</s-text>}
        {csv && (
          <s-text-area
            label={`If the download didn't start, copy this into a file named ${filename}`}
            value={csv}
            rows={4}
            readOnly
          />
        )}
      </s-stack>
    </fetcher.Form>
  );
}
