# Lesson 75: Web Search and Fetch — Reaching Beyond the Codebase

## When the Codebase Isn't Enough

The agent's primary data source is the local codebase — files on disk. But some tasks require information that doesn't exist locally:

- "Upgrade React Router to v7 — what changed in the API?"
- "This error: `ERR_OSSL_EVP_UNSUPPORTED` — how do I fix it?"
- "What's the current best practice for Next.js middleware?"
- "Fetch the OpenAPI spec from our staging server"

Three tools handle these cases: **WebSearchTool**, **WebFetchTool**, and **WebBrowserTool**.

---

## WebSearchTool: Internet Search

### Schema

```typescript
const inputSchema = z.strictObject({
  search_term: z
    .string()
    .describe(
      "The search query. Be specific and include relevant " +
      "keywords for better results."
    ),
});
```

### How It Works

WebSearchTool performs a web search and returns summarized results:

```typescript
async function executeWebSearch(input: { search_term: string }): Promise<string> {
  const results = await searchAPI.search(input.search_term);

  return results
    .map((result) => {
      return [
        `**${result.title}**`,
        result.url,
        result.snippet,
        "",
      ].join("\n");
    })
    .join("\n");
}
```

The output is structured but readable:

```
**React Router v7 Migration Guide**
https://reactrouter.com/upgrading/v6
Key changes: Route definitions now use a new format.
Loaders and actions are defined inline...

**Breaking Changes in React Router v7 - GitHub Discussion**
https://github.com/remix-run/react-router/discussions/10856
Summary of all breaking changes between v6 and v7...
```

### When the Agent Uses It

The system prompt includes guidance on when to search:

```
Use WebSearch when you need current information that may not be
in your training data: library versions, API changes, error messages,
best practices that evolve over time.
```

Common triggers:
- Error messages the agent doesn't recognize
- Library upgrade questions (APIs change between versions)
- "How do I..." questions about external tools or services
- When the agent's training data might be outdated

---

## WebFetchTool: Reading a Specific URL

### Schema

```typescript
const inputSchema = z.strictObject({
  url: z
    .string()
    .url()
    .describe("The URL to fetch. Must be a fully-formed, valid URL."),
});
```

### How It Works

WebFetchTool retrieves a URL and converts the HTML content to readable markdown:

```typescript
async function executeWebFetch(input: { url: string }): Promise<string> {
  const response = await fetch(input.url, {
    headers: {
      "User-Agent": "Claude-Code/1.0",
      Accept: "text/html,application/json,text/plain",
    },
    signal: AbortSignal.timeout(30000), // 30-second timeout
  });

  if (!response.ok) {
    throw new ToolError(
      `Failed to fetch ${input.url}: HTTP ${response.status} ${response.statusText}`
    );
  }

  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const json = await response.json();
    return JSON.stringify(json, null, 2);
  }

  if (contentType.includes("text/html")) {
    const html = await response.text();
    return htmlToMarkdown(html);
  }

  // Plain text
  return await response.text();
}
```

### HTML to Markdown Conversion

Raw HTML is noisy — navigation bars, footers, scripts, ads. The tool converts to clean markdown:

```typescript
function htmlToMarkdown(html: string): string {
  // Remove script and style tags entirely
  let clean = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  clean = clean.replace(/<style[\s\S]*?<\/style>/gi, "");

  // Convert common elements
  clean = clean.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n");
  clean = clean.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n");
  clean = clean.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n");
  clean = clean.replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n");
  clean = clean.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)");
  clean = clean.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`");
  clean = clean.replace(/<pre[^>]*>(.*?)<\/pre>/gis, "```\n$1\n```\n");

  // Remove remaining HTML tags
  clean = clean.replace(/<[^>]+>/g, "");

  // Clean up whitespace
  clean = clean.replace(/\n{3,}/g, "\n\n");

  return clean.trim();
}
```

This gives the model clean, readable content instead of raw HTML soup.

### Typical Usage

```typescript
// Fetch documentation page
WebFetch({ url: "https://docs.python.org/3/library/asyncio.html" })

// Fetch an API specification
WebFetch({ url: "https://api.example.com/openapi.json" })

// Fetch a changelog
WebFetch({ url: "https://github.com/vercel/next.js/releases/tag/v15.0.0" })
```

### Limitations

WebFetchTool has clear boundaries:

```typescript
// These will fail:
// - URLs requiring authentication
// - localhost / private IPs (runs from isolated server)
// - Binary content (PDFs, images, media)
// - Very large pages (content is truncated)
```

The error messages guide the model toward alternatives when fetch fails.

---

## WebBrowserTool: Full Browser Automation

For cases where simple fetch isn't enough — pages that require JavaScript rendering, interaction, or authentication — there's WebBrowserTool:

```typescript
const browserInputSchema = z.strictObject({
  action: z
    .enum([
      "navigate",
      "click",
      "type",
      "screenshot",
      "scroll",
      "wait",
      "evaluate",
    ])
    .describe("The browser action to perform"),
  url: z.string().optional().describe("URL to navigate to"),
  selector: z.string().optional().describe("CSS selector for the target element"),
  text: z.string().optional().describe("Text to type"),
  script: z.string().optional().describe("JavaScript to evaluate in page context"),
});
```

### Feature-Gated

WebBrowserTool is not available by default — it's feature-gated:

```typescript
export class WebBrowserTool extends Tool {
  get isEnabled(): boolean {
    return featureFlags.get("ENABLE_BROWSER_TOOL") === true;
  }
}
```

This is because browser automation:
- Requires a browser runtime (Puppeteer/Playwright)
- Has higher resource costs
- Can interact with external services (side effects)
- Needs careful permission management

### How It Works

```typescript
async function executeBrowserAction(input: BrowserInput): Promise<string> {
  switch (input.action) {
    case "navigate":
      await page.goto(input.url!, { waitUntil: "networkidle" });
      return `Navigated to ${input.url}`;

    case "click":
      await page.click(input.selector!);
      return `Clicked ${input.selector}`;

    case "type":
      await page.type(input.selector!, input.text!);
      return `Typed "${input.text}" into ${input.selector}`;

    case "screenshot":
      const buffer = await page.screenshot({ fullPage: false });
      const base64 = buffer.toString("base64");
      return {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: base64 },
      };

    case "evaluate":
      const result = await page.evaluate(input.script!);
      return JSON.stringify(result, null, 2);
  }
}
```

The screenshot action returns an image that multimodal models can interpret — useful for visually verifying UI changes.

---

## When Each Tool Is Appropriate

```
Need general information?            → WebSearchTool
Know the exact URL?                  → WebFetchTool
Need JavaScript rendering?           → WebBrowserTool
Need to interact with a page?        → WebBrowserTool
Need to verify visual appearance?    → WebBrowserTool (screenshot)
```

### Decision Flow

```
Agent encounters unknown error
        │
        ▼
  ┌──────────────┐
  │ Search first  │ → WebSearchTool("ERR_OSSL_EVP_UNSUPPORTED node 18")
  └──────┬───────┘
        ▼
  ┌──────────────┐
  │ Found docs URL│ → WebFetchTool("https://nodejs.org/docs/...")
  └──────┬───────┘
        ▼
  ┌──────────────┐
  │ Apply fix     │ → Edit the configuration based on docs
  └──────────────┘
```

---

## Content Size Management

Web content can be enormous. The tools enforce limits:

```typescript
const MAX_FETCH_CONTENT_SIZE = 100000; // ~100KB of text

function truncateContent(content: string): string {
  if (content.length <= MAX_FETCH_CONTENT_SIZE) {
    return content;
  }

  return (
    content.substring(0, MAX_FETCH_CONTENT_SIZE) +
    "\n\n... [Content truncated. Page contains " +
    `${content.length} characters, showing first ${MAX_FETCH_CONTENT_SIZE}.]`
  );
}
```

This prevents a single web fetch from consuming the entire context window.

---

## Security Considerations

Web tools interact with the outside world, which raises security concerns:

1. **No authentication support**: Prevents leaking credentials through the agent
2. **Isolated execution**: Fetch runs from a sandboxed server, not the user's machine
3. **No localhost access**: Prevents the agent from probing the user's local network
4. **Read-only by default**: WebSearchTool and WebFetchTool have no side effects
5. **Browser tool is gated**: Requires explicit feature flag because it can interact with pages

```typescript
function validateUrl(url: string): void {
  const parsed = new URL(url);

  // Block private/local addresses
  if (
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname.startsWith("192.168.") ||
    parsed.hostname.startsWith("10.")
  ) {
    throw new ToolError(
      "Cannot fetch localhost or private network URLs. " +
      "This tool runs from an isolated server."
    );
  }
}
```

---

## Key Takeaways

1. **WebSearchTool** performs internet searches — useful for error messages, library docs, and current best practices.

2. **WebFetchTool** retrieves specific URLs as readable markdown — useful for documentation pages, API specs, and changelogs.

3. **WebBrowserTool** provides full browser automation (navigate, click, type, screenshot) — feature-gated due to resource costs and side-effect potential.

4. **HTML-to-markdown conversion** strips noise (scripts, styles, navigation) to give the model clean content.

5. **Content truncation** prevents web content from overwhelming the context window.

6. **Security boundaries** prevent localhost access, authentication leaks, and uncontrolled side effects.

---

## What's Next

All search tools — Grep, Glob, WebSearch, WebFetch — can return massive amounts of data. Lesson 76 covers the **pagination system** that keeps results manageable: `head_limit`, `offset`, and the "has more" indicators.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Security Restrictions
**Question:** What are the security restrictions on WebFetchTool and why does each one exist? What would happen if localhost access were allowed?

[View Answer](../../answers/08-search-and-navigation/answer-75.md#exercise-1)

### Exercise 2 — Build an HTML-to-Markdown Converter
**Challenge:** Implement an `htmlToMarkdown` function that strips `<script>` and `<style>` tags, converts headings (`h1`-`h3`), paragraphs, links, code blocks, and inline code to markdown, removes remaining HTML tags, and cleans up excess whitespace.

Write your solution in your IDE first, then check:

[View Answer](../../answers/08-search-and-navigation/answer-75.md#exercise-2)

### Exercise 3 — URL Validator with Security Checks
**Challenge:** Write a `validateUrl` function that parses a URL, blocks `localhost`, `127.0.0.1`, private IP ranges (`192.168.*`, `10.*`, `172.16-31.*`), and non-HTTP(S) schemes. Throw descriptive errors for each case.

Write your solution in your IDE first, then check:

[View Answer](../../answers/08-search-and-navigation/answer-75.md#exercise-3)

### Exercise 4 — Content Truncation with Smart Boundaries
**Challenge:** Implement a `truncateContent` function that enforces a character limit but always cuts at a newline boundary (never mid-line). Append a notice showing the original size and truncated size.

Write your solution in your IDE first, then check:

[View Answer](../../answers/08-search-and-navigation/answer-75.md#exercise-4)
