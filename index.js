const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, "..", "public");
const VERSION = "5.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function stripHtml(s = "") {
  return String(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "BlasterPro/5.0 (buscador educativo)",
        Accept: "application/json",
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function wikiSearch(query, lang) {
  const endpoint = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
    query
  )}&srlimit=8&format=json&origin=*`;
  const data = await fetchJson(endpoint);
  const hits = data?.query?.search || [];
  return hits.map((hit) => ({
    title: hit.title,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, "_"))}`,
    description: stripHtml(hit.snippet || ""),
    source: `Wikipedia ${lang.toUpperCase()}`,
  }));
}

async function openLibrarySearch(query) {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(
    query
  )}&limit=10`;
  const data = await fetchJson(url, 10000);
  const docs = data?.docs || [];
  return docs.map((doc) => {
    const work = doc.key ? `https://openlibrary.org${doc.key}` : "";
    const year = doc.first_publish_year ? ` · ${doc.first_publish_year}` : "";
    const author = (doc.author_name && doc.author_name[0]) || "Autor desconocido";
    const cover = doc.cover_i
      ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`
      : "";
    return {
      title: doc.title || "Sin título",
      url: work,
      description: `${author}${year}${doc.subject ? " · " + doc.subject.slice(0, 3).join(", ") : ""}`,
      image: cover,
      source: "Open Library",
    };
  });
}

async function wikiImages(query, lang) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(
    query
  )}&gsrlimit=8&prop=pageimages&piprop=thumbnail&pithumbsize=400&format=json&origin=*`;
  try {
    const data = await fetchJson(url);
    const pages = Object.values(data?.query?.pages || {});
    return pages
      .filter((p) => p.thumbnail?.source)
      .map((p) => ({
        title: p.title,
        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`,
        image: p.thumbnail.source,
        description: "Imagen de Wikipedia",
        source: "Wikipedia",
      }));
  } catch {
    return [];
  }
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = (item.url || item.title || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function searchAll(query) {
  const looksComic = /comic|cómic|manga|historieta|batman|marvel|dc\b|spiderman|spider-man|webtoon/i.test(
    query
  );
  const bookQuery = looksComic ? `${query} comic` : query;

  const settled = await Promise.allSettled([
    wikiSearch(query, "es"),
    wikiSearch(query, "en"),
    openLibrarySearch(bookQuery),
    wikiImages(query, "es"),
    wikiImages(query, "en"),
  ]);

  const [wikiEs, wikiEn, books, imgEs, imgEn] = settled.map((s) =>
    s.status === "fulfilled" ? s.value : []
  );

  const web = dedupe([...(wikiEs || []), ...(books || []), ...(wikiEn || [])]);
  const images = dedupe(
    [...(books || []).filter((b) => b.image).map((b) => ({ ...b, url: b.image })), ...(imgEs || []), ...(imgEn || [])]
  );

  const providers = [];
  if (wikiEs?.length || wikiEn?.length) providers.push("wikipedia");
  if (books?.length) providers.push("openlibrary");

  return {
    provider: providers.join("+") || "ninguno",
    query,
    web,
    images,
    videos: [],
    news: [],
    youtube: [],
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    send(res, 204, "");
    return;
  }

  if (url.pathname === "/api/health") {
    send(res, 200, {
      ok: true,
      version: VERSION,
      realSearch: true,
      youtube: false,
      country: "DO",
      lang: "es",
      engines: ["wikipedia", "openlibrary"],
    });
    return;
  }

  if (url.pathname === "/api/search") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) {
      send(res, 400, { error: "Escribe una búsqueda." });
      return;
    }
    try {
      const data = await searchAll(q);
      send(res, 200, data);
    } catch (err) {
      send(res, 500, { error: "No se pudo buscar ahora.", detail: String(err.message || err) });
    }
    return;
  }

  let filePath = path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname);
  if (!filePath.startsWith(PUBLIC)) {
    send(res, 403, { error: "Forbidden" });
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      send(res, 404, "Not Found", "text/plain; charset=utf-8");
      return;
    }
    send(res, 200, buf.toString("utf8"), MIME[path.extname(filePath)] || "application/octet-stream");
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Blaster Pro ${VERSION} en http://0.0.0.0:${PORT}`);
});
