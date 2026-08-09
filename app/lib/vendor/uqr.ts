/**
 * Thin typed wrapper around vendored uqr (MIT).
 * @see https://github.com/unjs/uqr
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — vendored ESM without local type declarations
import { renderSVG as renderSvgImpl } from "./uqr.mjs";

type QrRenderOptions = {
  ecc?: "L" | "M" | "Q" | "H";
  border?: number;
  pixelSize?: number;
  whiteColor?: string;
  blackColor?: string;
};

export function renderPairingQrSvg(data: string, options: QrRenderOptions = {}) {
  return renderSvgImpl(data, options) as string;
}
