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
 * Permits safe numeric CSS lengths (e.g. "48px", "3.5rem", "64") up to 32 chars while
 * blocking CSS property injection (;), url(...), expression(...), and </style> breakouts.
 */
export function isValidWidgetBubbleSize(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 32) return false;
  return /^\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%)?$/i.test(trimmed);
}
