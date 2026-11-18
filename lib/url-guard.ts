/**
 * Strict URL validation guard for operator-supplied widget icon URLs.
 * Blocks protocol-relative (//evil), backslash-smuggled (/\evil), credentialed,
 * control-character, empty-hostname, and dangerous URI schemes (javascript:, data:).
 */
export function isValidWidgetIconUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return false;
  if (/[\s<>"'`\\\x00-\x1f\x7f]/.test(trimmed)) return false;
  if (trimmed.startsWith("//")) return false;

  if (trimmed.startsWith("/")) {
    try {
      const resolved = new URL(trimmed, "https://relative.tokki.local");
      return resolved.origin === "https://relative.tokki.local";
    } catch {
      return false;
    }
  }

  try {
    const parsed = new URL(trimmed);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      Boolean(parsed.hostname) &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

/**
 * Strict CSS length validation guard for operator-supplied widget launcher bubble sizes.
 * Permits safe numeric CSS lengths within bounded launcher dimensions:
 *   - px or unitless: 24..160 (e.g. "48px", "64")
 *   - rem or em: 1.5..10 (e.g. "3.5rem", "4em")
 * Blocks CSS property injection (;), url(...), </style> breakouts, 0px invisible
 * launchers, and viewport/oversized clickjacking overlays (100vw, 100vh, %, 99999px).
 */
export function isValidWidgetBubbleSize(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 32) return false;
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(px|rem|em)?$/i);
  if (!match) return false;
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return false;
  const unit = (match[2] ?? "px").toLowerCase();
  if (unit === "rem" || unit === "em") {
    return num >= 1.5 && num <= 10;
  }
  return num >= 24 && num <= 160;
}
