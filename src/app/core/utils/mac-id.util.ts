// Standard 6-octet MAC address, colon-separated, case-insensitive
// (AA:BB:CC:DD:EE:FF). Centralised here so every entry point (dashboard
// search boxes, direct URL navigation to /operations/:macId) validates
// and normalizes the same way.
const MAC_REGEX = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
const MAC_HEX_ONLY = /^[0-9A-Fa-f]{12}$/;

// Returns the normalized, uppercase, colon-separated MAC ID if the input
// is a valid MAC address (colons already present, or 12 bare hex chars
// that we insert colons into), or null if it isn't valid at all.
export function normalizeMacId(input: string): string | null {
  const trimmed = input.trim();
  if (MAC_REGEX.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  const stripped = trimmed.replace(/[:\-\s]/g, '');
  if (MAC_HEX_ONLY.test(stripped)) {
    return stripped.toUpperCase().match(/.{1,2}/g)!.join(':');
  }
  return null;
}

export const MAC_ID_FORMAT_ERROR = 'Enter a valid MAC ID like AA:BB:CC:DD:EE:FF.';
