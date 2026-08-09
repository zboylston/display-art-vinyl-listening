"use client";

import { useMemo } from "react";
import { renderPairingQrSvg } from "../lib/vendor/uqr";

type PairingQrProps = {
  url: string;
  label?: string;
};

/** Renders a pairing QR as inline SVG (no network, no extra npm install). */
export function PairingQr({ url, label = "Pairing QR code" }: PairingQrProps) {
  const svg = useMemo(
    () =>
      renderPairingQrSvg(url, {
        ecc: "M",
        border: 2,
        pixelSize: 5,
        blackColor: "#1a1612",
        whiteColor: "#fff8ee",
      }),
    [url],
  );

  return (
    <div
      className="tv-pair__qr"
      role="img"
      aria-label={label}
      // URL is always our own origin + a validated 6-char code.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
