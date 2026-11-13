// FILE: qr-code.tsx
// Purpose: One QR renderer (qrcode library, medium error correction) for every scannable code.
// Layer: UI primitive
import QRCode from "qrcode";
import { useEffect, useState } from "react";

export function QrCode({
  value,
  alt,
  failedLabel,
  size = 180,
}: {
  readonly value: string;
  readonly alt: string;
  readonly failedLabel: string;
  readonly size?: number;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setDataUrl(null);
    QRCode.toDataURL(value, { errorCorrectionLevel: "M", margin: 2, width: size * 2 })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);
  if (failed) {
    return (
      <p className="rounded-card border border-dashed p-4 text-center text-ui-sm text-muted-foreground">
        {failedLabel}
      </p>
    );
  }
  if (!dataUrl) {
    return (
      <div
        className="animate-pulse rounded-control border bg-muted"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <img
      alt={alt}
      className="rounded-control border bg-white"
      height={size}
      src={dataUrl}
      width={size}
    />
  );
}
