// The WebDAV XML the CalDAV provider reads (RFC 4918 multistatus; T4-13) —
// a small, strict reader, hand-rolled rather than a dependency (CLAUDE.md,
// Stack: ask before adding one; the subset needed is a page).
//
// What it reads: elements, attributes, namespaces (prefixed and default,
// scoped as XML scopes them), text with the five named entities and
// numeric character references, CDATA, comments and the XML declaration.
//
// What it refuses, rather than half-reads: a DOCTYPE (and so every entity
// declaration — nothing here expands a name a server defined, so a
// billion-laughs body is a refusal, not a hang), an unknown named entity, a
// tag that does not close, and an end tag that does not match its start.
// A refusal is a `DavXmlError`; the caller turns it into its own code.

/** DAV: — RFC 4918's namespace. */
export const DAV_NS = "DAV:";
/** CalDAV's namespace — RFC 4791 and RFC 6638. */
export const CALDAV_NS = "urn:ietf:params:xml:ns:caldav";

export interface XmlElement {
  /** the namespace URI, or "" when none is in scope */
  ns: string;
  /** the local name */
  name: string;
  attrs: Readonly<Record<string, string>>;
  children: XmlElement[];
  /** every text node directly inside it, concatenated */
  text: string;
}

export class DavXmlError extends Error {
  override readonly name = "DavXmlError";
}

const NAMED: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]*);/g, (_m, ref: string) => {
    if (ref.startsWith("#x") || ref.startsWith("#X")) return String.fromCodePoint(Number.parseInt(ref.slice(2), 16));
    if (ref.startsWith("#")) return String.fromCodePoint(Number.parseInt(ref.slice(1), 10));
    const named = NAMED[ref];
    if (named === undefined) throw new DavXmlError(`an entity this reader does not define (&${ref.slice(0, 20)};)`);
    return named;
  });
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

interface Open {
  el: XmlElement;
  qname: string;
  scope: Map<string, string>;
}

/** Parse a document into its root element. Throws `DavXmlError`. */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { ns: "", name: "#document", attrs: {}, children: [], text: "" };
  const stack: Open[] = [{ el: root, qname: "", scope: new Map([["xml", "http://www.w3.org/XML/1998/namespace"]]) }];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    const top = stack[stack.length - 1]!;
    if (lt < 0) {
      if (xml.slice(i).trim() !== "") top.el.text += decode(xml.slice(i));
      break;
    }
    if (lt > i) top.el.text += decode(xml.slice(i, lt));
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) throw new DavXmlError("an unclosed processing instruction");
      i = end + 2;
    } else if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) throw new DavXmlError("an unclosed comment");
      i = end + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) throw new DavXmlError("an unclosed CDATA section");
      top.el.text += xml.slice(lt + 9, end);
      i = end + 3;
    } else if (xml.startsWith("<!", lt)) {
      throw new DavXmlError("a DOCTYPE or declaration — refused, so no server-defined entity is ever expanded");
    } else if (xml.startsWith("</", lt)) {
      const end = xml.indexOf(">", lt + 2);
      if (end < 0) throw new DavXmlError("an unclosed end tag");
      const qname = xml.slice(lt + 2, end).trim();
      if (stack.length < 2 || top.qname !== qname) throw new DavXmlError(`an end tag </${qname.slice(0, 40)}> that closes nothing open`);
      stack.pop();
      i = end + 1;
    } else {
      // a start tag: find its end outside quoted attribute values
      let j = lt + 1;
      let quote: string | null = null;
      for (; j < n; j++) {
        const ch = xml[j]!;
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === ">") break;
      }
      if (j >= n) throw new DavXmlError("an unclosed start tag");
      let body = xml.slice(lt + 1, j);
      const selfClosing = body.endsWith("/");
      if (selfClosing) body = body.slice(0, -1);
      const m = /^([^\s/>]+)/.exec(body);
      if (!m) throw new DavXmlError("a start tag with no name");
      const qname = m[1]!;
      const scope = new Map(top.scope);
      const raw: Record<string, string> = {};
      for (const a of body.slice(qname.length).matchAll(ATTR_RE)) {
        const key = a[1]!;
        const value = decode(a[2] ?? a[3] ?? "");
        if (key === "xmlns") scope.set("", value);
        else if (key.startsWith("xmlns:")) scope.set(key.slice(6), value);
        else raw[key] = value;
      }
      const colon = qname.indexOf(":");
      const prefix = colon < 0 ? "" : qname.slice(0, colon);
      const name = colon < 0 ? qname : qname.slice(colon + 1);
      const ns = scope.get(prefix);
      if (ns === undefined && prefix !== "") throw new DavXmlError(`an undeclared namespace prefix (${prefix.slice(0, 20)})`);
      const attrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) attrs[k.includes(":") ? k.slice(k.indexOf(":") + 1) : k] = v;
      const el: XmlElement = { ns: ns ?? "", name, attrs, children: [], text: "" };
      top.el.children.push(el);
      if (!selfClosing) stack.push({ el, qname, scope });
      i = j + 1;
    }
  }
  if (stack.length !== 1) throw new DavXmlError(`an element that never closes (<${stack[stack.length - 1]!.qname.slice(0, 40)}>)`);
  const doc = root.children[0];
  if (!doc || root.children.length !== 1) throw new DavXmlError(root.children.length === 0 ? "no root element" : "more than one root element");
  return doc;
}

/** The first child `ns`:`name`, or undefined. */
export function child(el: XmlElement | undefined, ns: string, name: string): XmlElement | undefined {
  return el?.children.find((c) => c.ns === ns && c.name === name);
}

/** Every child `ns`:`name`. */
export function childrenOf(el: XmlElement | undefined, ns: string, name: string): XmlElement[] {
  return el ? el.children.filter((c) => c.ns === ns && c.name === name) : [];
}

/** Text with markup escaped, for a value put into a request body. */
export function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === '"' ? "&quot;" : "&apos;"));
}

/** One `<d:response>` of a multistatus: its href and the properties a 2xx propstat returned, keyed `ns|name`. */
export interface DavResponse {
  href: string;
  props: ReadonlyMap<string, XmlElement>;
}

export const propKey = (ns: string, name: string): string => `${ns}|${name}`;

/** A 207 body's responses. A propstat whose status is not 2xx contributes nothing — a property the server could not give is absent, never guessed. */
export function parseMultistatus(xml: string): DavResponse[] {
  const doc = parseXml(xml);
  if (doc.ns !== DAV_NS || doc.name !== "multistatus") throw new DavXmlError(`not a DAV multistatus (<${doc.name.slice(0, 40)}>)`);
  const out: DavResponse[] = [];
  for (const r of childrenOf(doc, DAV_NS, "response")) {
    const href = child(r, DAV_NS, "href")?.text.trim();
    if (!href) continue;
    const props = new Map<string, XmlElement>();
    for (const ps of childrenOf(r, DAV_NS, "propstat")) {
      const status = child(ps, DAV_NS, "status")?.text.trim() ?? "";
      const code = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(status)?.[1];
      if (!code || !code.startsWith("2")) continue;
      for (const p of child(ps, DAV_NS, "prop")?.children ?? []) props.set(propKey(p.ns, p.name), p);
    }
    out.push({ href, props });
  }
  return out;
}
