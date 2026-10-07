/**
 * "Chrome 141 · Windows" from a user agent. Playback trouble is very often
 * browser-specific (Edge sleeping tabs, Firefox codecs, Safari autoplay), so
 * every log line about a viewer says what they were using.
 */
export function describeBrowser(ua: string | undefined): string {
  if (!ua) return 'unknown';
  const pick = (re: RegExp) => ua.match(re)?.[1]?.split('.')[0];

  let name = 'Other';
  let version: string | undefined;
  if ((version = pick(/Edg(?:A|iOS)?\/([\d.]+)/))) name = 'Edge';
  else if ((version = pick(/OPR\/([\d.]+)/))) name = 'Opera';
  else if ((version = pick(/SamsungBrowser\/([\d.]+)/))) name = 'Samsung';
  else if ((version = pick(/(?:Firefox|FxiOS)\/([\d.]+)/))) name = 'Firefox';
  else if ((version = pick(/(?:Chrome|CriOS)\/([\d.]+)/))) name = 'Chrome';
  else if (/Safari\//.test(ua) && (version = pick(/Version\/([\d.]+)/))) name = 'Safari';

  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad|iPod/.test(ua)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'other OS';

  return `${name}${version ? ` ${version}` : ''} · ${os}`;
}
