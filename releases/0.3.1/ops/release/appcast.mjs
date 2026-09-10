// The Sparkle appcast the macOS app's auto-updater reads, generated from
// a GitHub release — "an EdDSA-signed appcast whose feed is generated from
// the GitHub release itself, so the app updates without any FSL-run
// server" (docs/product/desktop-app-plan.md, ratified 2026-09-07).
//
//   node ops/release/appcast.mjs <version> --url <dmg url> --length <bytes> \
//        [--signature <ed25519>] [--notes <html url>] [--min-system 13.0]
//
// THE SIGNATURE IS NOT PRODUCED HERE. Sparkle signs with an EdDSA private
// key that must live in a repo secret (SPARKLE_PRIVATE_KEY) and reach this
// script through `sign_update -f -` in the workflow — never in the repo,
// never in an artifact. Called without one, this emits the feed with a
// clearly marked placeholder and reports `signed: false`, so the appcast
// job can fail loudly rather than publish a feed the app will reject.
//
// There is no macOS app yet: the release workflow's appcast job is a
// documented stub. This module is the part that is real and tested, so
// the stub is a job to enable, not a thing to design later.

/** Sparkle's placeholder — a feed carrying it must never be published. */
export const UNSIGNED_PLACEHOLDER = "UNSIGNED-set-SPARKLE_PRIVATE_KEY-in-repo-secrets";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * @param {{version: string, url: string, length: number|string, signature?: string,
 *          pubDate?: string, notesUrl?: string, description?: string,
 *          minimumSystemVersion?: string, title?: string, feedTitle?: string,
 *          feedUrl?: string, channel?: string}} item
 * @returns {{xml: string, signed: boolean}}
 */
export function renderAppcast(item) {
  if (!item?.version) throw new Error("appcast: version is required");
  if (!item.url) throw new Error("appcast: url (the DMG's download url) is required");
  const length = Number(item.length);
  if (!Number.isFinite(length) || length <= 0) throw new Error("appcast: length must be the DMG's size in bytes");

  const version = String(item.version).replace(/^v/, "");
  const signature = item.signature && item.signature !== "" ? item.signature : UNSIGNED_PLACEHOLDER;
  const signed = signature !== UNSIGNED_PLACEHOLDER;
  const pubDate = item.pubDate ?? new Date().toUTCString();

  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">',
    "  <channel>",
    `    <title>${esc(item.feedTitle ?? "Metistry")}</title>`,
    ...(item.feedUrl ? [`    <link>${esc(item.feedUrl)}</link>`] : []),
    "    <description>Metistry releases for macOS</description>",
    "    <language>en</language>",
    "    <item>",
    `      <title>${esc(item.title ?? `Metistry ${version}`)}</title>`,
    `      <pubDate>${esc(pubDate)}</pubDate>`,
    `      <sparkle:version>${esc(version)}</sparkle:version>`,
    `      <sparkle:shortVersionString>${esc(version)}</sparkle:shortVersionString>`,
    ...(item.channel ? [`      <sparkle:channel>${esc(item.channel)}</sparkle:channel>`] : []),
    ...(item.minimumSystemVersion ? [`      <sparkle:minimumSystemVersion>${esc(item.minimumSystemVersion)}</sparkle:minimumSystemVersion>`] : []),
    ...(item.notesUrl ? [`      <sparkle:releaseNotesLink>${esc(item.notesUrl)}</sparkle:releaseNotesLink>`] : []),
    ...(item.description ? [`      <description><![CDATA[${String(item.description).replace(/\]\]>/g, "]]&gt;")}]]></description>`] : []),
    ...(signed ? [] : [`      <!-- ${UNSIGNED_PLACEHOLDER}: sign with Sparkle's sign_update using the SPARKLE_PRIVATE_KEY repo secret; DO NOT PUBLISH this feed as it stands -->`]),
    `      <enclosure url="${esc(item.url)}" length="${length}" type="application/octet-stream" sparkle:edSignature="${esc(signature)}"/>`,
    "    </item>",
    "  </channel>",
    "</rss>",
    "",
  ];
  return { xml: lines.join("\n"), signed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const version = argv[0]?.startsWith("--") ? flag("version") : argv[0];
  const { xml, signed } = renderAppcast({
    version,
    url: flag("url"),
    length: flag("length"),
    signature: flag("signature") ?? process.env.SPARKLE_SIGNATURE,
    notesUrl: flag("notes"),
    minimumSystemVersion: flag("min-system"),
    feedUrl: flag("feed-url"),
    pubDate: flag("pub-date"),
  });
  if (!signed && !argv.includes("--allow-unsigned")) {
    process.stderr.write("appcast: refusing to emit an unsigned feed — pass --signature (from `sign_update`) or --allow-unsigned for a dry run\n");
    process.exit(1);
  }
  process.stdout.write(xml);
}
