// Resolves media references in card HTML ([sound:x], src="x", url(x)) to
// data: URLs, so cards can render inside an isolated sandboxed frame.

const SRC_RE = /(\bsrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^"'\s>]+))/gi;
const URL_RE = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
const SOUND_RE = /\[sound:([^\]]+)\]/g;

const isLocal = (ref: string) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref);

function decodeRef(ref: string): string {
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}

export function referencedMedia(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(SRC_RE)) {
    const ref = m[2] ?? m[3] ?? m[4];
    if (ref && isLocal(ref)) out.add(decodeRef(ref));
  }
  for (const m of html.matchAll(URL_RE)) if (isLocal(m[2])) out.add(decodeRef(m[2]));
  for (const m of html.matchAll(SOUND_RE)) out.add(m[1]);
  return out;
}

export type MediaLookup = (name: string) => Promise<string | undefined>;

export async function inlineMedia(html: string, lookup: MediaLookup): Promise<string> {
  const urls = new Map<string, string | undefined>();
  await Promise.all([...referencedMedia(html)].map(async (n) => urls.set(n, await lookup(n))));
  const resolve = (ref: string) => urls.get(decodeRef(ref));
  return html
    .replace(SOUND_RE, (m, name: string) => {
      const url = urls.get(name);
      if (!url) return m;
      const tag = /\.(mp4|webm|mkv|mov)$/i.test(name) ? "video" : "audio";
      return `<${tag} class="sound" controls preload="auto" src="${url}"></${tag}>`;
    })
    .replace(SRC_RE, (m, pre: string, dq?: string, sq?: string, bare?: string) => {
      const ref = dq ?? sq ?? bare ?? "";
      const url = ref && isLocal(ref) ? resolve(ref) : undefined;
      return url ? `${pre}"${url}"` : m;
    })
    .replace(URL_RE, (m, _q: string, ref: string) => {
      const url = isLocal(ref) ? resolve(ref) : undefined;
      return url ? `url("${url}")` : m;
    });
}
