# Answers: Lesson 75 — Web Search and Fetch

## Exercise 1
**Question:** What are the security restrictions on WebFetchTool and why does each one exist?

**Answer:** WebFetchTool has five key restrictions: (1) No authentication support — prevents leaking user credentials through API calls routed through external servers. (2) No localhost/private IP access — prevents the agent from probing the user's local network, databases, or internal services. If allowed, a prompt injection could direct the agent to fetch `http://localhost:3000/admin/delete-all`. (3) Isolated execution (sandboxed server) — the fetch runs remotely, not on the user's machine, preventing local network reconnaissance. (4) No binary content — only text-based formats are returned, preventing the model from receiving opaque data it can't reason about. (5) Content size truncation — prevents a single fetch from consuming the entire context window, which would degrade reasoning quality and increase cost.

---

## Exercise 2
**Challenge:** Implement an `htmlToMarkdown` function.

**Answer:**
```typescript
function htmlToMarkdown(html: string): string {
  let clean = html;

  clean = clean.replace(/<script[\s\S]*?<\/script>/gi, "");
  clean = clean.replace(/<style[\s\S]*?<\/style>/gi, "");
  clean = clean.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  clean = clean.replace(/<footer[\s\S]*?<\/footer>/gi, "");

  clean = clean.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n");
  clean = clean.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n");
  clean = clean.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n");
  clean = clean.replace(/<h4[^>]*>(.*?)<\/h4>/gi, "#### $1\n");

  clean = clean.replace(/<p[^>]*>(.*?)<\/p>/gis, "$1\n\n");

  clean = clean.replace(
    /<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi,
    "[$2]($1)"
  );

  clean = clean.replace(/<pre[^>]*>(.*?)<\/pre>/gis, "```\n$1\n```\n");
  clean = clean.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`");

  clean = clean.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n");
  clean = clean.replace(/<\/?[uo]l[^>]*>/gi, "\n");

  clean = clean.replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**");
  clean = clean.replace(/<b[^>]*>(.*?)<\/b>/gi, "**$1**");
  clean = clean.replace(/<em[^>]*>(.*?)<\/em>/gi, "*$1*");
  clean = clean.replace(/<i[^>]*>(.*?)<\/i>/gi, "*$1*");

  clean = clean.replace(/<br\s*\/?>/gi, "\n");

  clean = clean.replace(/<[^>]+>/g, "");

  clean = clean.replace(/&amp;/g, "&");
  clean = clean.replace(/&lt;/g, "<");
  clean = clean.replace(/&gt;/g, ">");
  clean = clean.replace(/&quot;/g, '"');
  clean = clean.replace(/&#39;/g, "'");

  clean = clean.replace(/\n{3,}/g, "\n\n");
  clean = clean.replace(/[ \t]+\n/g, "\n");

  return clean.trim();
}
```
**Explanation:** The function processes HTML in a specific order: first remove noise elements entirely (scripts, styles, nav, footer), then convert structural elements to markdown equivalents, then strip remaining tags, then decode HTML entities, and finally clean up whitespace. The order matters — `<pre>` must be converted before `<code>` to avoid double-processing code blocks.

---

## Exercise 3
**Challenge:** Write a `validateUrl` function with security checks.

**Answer:**
```typescript
class UrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlValidationError";
  }
}

function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UrlValidationError(
      `Invalid URL: "${url}". Must be a fully-formed URL.`
    );
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new UrlValidationError(
      `Unsupported protocol: ${parsed.protocol}. Only HTTP and HTTPS are allowed.`
    );
  }

  const hostname = parsed.hostname;

  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    throw new UrlValidationError(
      "Cannot fetch localhost URLs. This tool runs from an isolated server."
    );
  }

  const ipParts = hostname.split(".");
  if (ipParts.length === 4 && ipParts.every((p) => /^\d+$/.test(p))) {
    const first = parseInt(ipParts[0]);
    const second = parseInt(ipParts[1]);

    if (first === 10) {
      throw new UrlValidationError("Cannot fetch private network URLs (10.x.x.x).");
    }
    if (first === 172 && second >= 16 && second <= 31) {
      throw new UrlValidationError("Cannot fetch private network URLs (172.16-31.x.x).");
    }
    if (first === 192 && second === 168) {
      throw new UrlValidationError("Cannot fetch private network URLs (192.168.x.x).");
    }
    if (first === 169 && second === 254) {
      throw new UrlValidationError("Cannot fetch link-local URLs (169.254.x.x).");
    }
  }
}
```
**Explanation:** The function validates in layers: first parse the URL (catches malformed strings), then check the protocol (blocks `file://`, `ftp://`, etc.), then check for localhost variants, then check for private IP ranges per RFC 1918. The 169.254.x.x check catches link-local addresses that could be used to access cloud metadata services (like AWS EC2 instance metadata at 169.254.169.254).

---

## Exercise 4
**Challenge:** Implement `truncateContent` with smart newline boundaries.

**Answer:**
```typescript
const MAX_FETCH_CONTENT_SIZE = 100_000;

function truncateContent(content: string, maxSize = MAX_FETCH_CONTENT_SIZE): string {
  if (content.length <= maxSize) {
    return content;
  }

  const roughCut = content.substring(0, maxSize);
  const lastNewline = roughCut.lastIndexOf("\n");

  const cleanCut = lastNewline > 0
    ? roughCut.substring(0, lastNewline)
    : roughCut;

  return (
    cleanCut +
    `\n\n... [Content truncated at line boundary. ` +
    `Showing ${cleanCut.length.toLocaleString()} of ` +
    `${content.length.toLocaleString()} characters.]`
  );
}
```
**Explanation:** The function first checks if truncation is needed. If so, it cuts at `maxSize` then backtracks to the last newline to avoid breaking mid-line. The fallback (`lastNewline > 0`) handles the rare case where there are no newlines in the first `maxSize` characters. The notice uses `toLocaleString()` for readable numbers (e.g., "100,000 of 523,847 characters").
