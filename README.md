# web2md

Local MCP server for **token-efficient** web page fetching. Converts HTML to Markdown with tiered access to minimize LLM context usage.

## Why?

```
Problem:
  WebFetch("https://docs.example.com") → 50,000 tokens
  You needed → 500 tokens of actual info
  Waste → 99%

Solution:
  web_outline(url) → 200 tokens (see structure)
  web_section(url, "Authentication") → 800 tokens (just that part)
  Savings → 97%
```

**Also:**
- Runs 100% locally — no third-party services see your content
- 24-hour disk cache — same URL = instant response
- Playwright rendering — handles JS-heavy SPAs
- Readability extraction — removes ads, nav, cruft

## Quick Start

```bash
# Clone
git clone https://github.com/YOUR_USERNAME/web2md.git
cd web2md

# Install
npm install

# Test it works
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node server.js
```

## Add to Claude Code

Add to your `.mcp.json` (in your project or `~/.claude/.mcp.json`):

```json
{
  "mcpServers": {
    "web2md": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/web2md/server.js"]
    }
  }
}
```

Restart Claude Code. You now have these tools:

## Tools

### `web_outline` — Use this first!

Get page structure with token estimates. ~200 tokens output.

```
mcp__web2md__web_outline url="https://react.dev/reference/react/useState"
```

Output:
```
# useState

Source: https://react.dev/reference/react/useState
Total: ~4500 tokens | 8 sections | fresh fetch

## Outline

- Reference (~80 tokens)
  - useState(initialState) (~500 tokens)
  - Parameters (~200 tokens)
  - Returns (~150 tokens)
- Usage (~2000 tokens)
  - Adding state to a component (~400 tokens)
  - Updating state based on previous (~300 tokens)
- Troubleshooting (~800 tokens)
```

### `web_section` — Fetch only what you need

```
mcp__web2md__web_section url="https://react.dev/reference/react/useState" headings="Parameters"
```

Or multiple sections:
```
mcp__web2md__web_section url="..." headings=["Parameters", "Returns"]
```

### `web_search` — Find specific content

```
mcp__web2md__web_search url="https://react.dev/reference/react/useState" query="initializer function"
```

Returns matching sections with context excerpts.

### `web_content` — Full page (with cap)

```
mcp__web2md__web_content url="https://example.com" max_tokens=4000
```

Automatically truncates. Use `web_outline` + `web_section` for better control.

## Options

All tools support:

| Option | Default | Description |
|--------|---------|-------------|
| `render_js` | `true` | Use Playwright for JS rendering. Set `false` for static sites (faster). |

## Cache

- Location: `~/.cache/web2md/`
- TTL: 24 hours
- Clear: `rm -rf ~/.cache/web2md`

## Token Savings Example

| Approach | Tokens | Time |
|----------|--------|------|
| Full page fetch | 50,000 | 3s |
| Outline only | 200 | 3s (first), instant (cached) |
| Outline + 2 sections | 1,500 | instant (cached) |
| **Savings** | **97%** | |

## Requirements

- Node.js 18+
- ~200MB disk for Chromium (auto-installed)

## How It Works

1. **Fetch**: Playwright renders JS-heavy pages (or simple fetch for static)
2. **Extract**: Mozilla Readability removes boilerplate
3. **Convert**: Turndown converts HTML → GitHub-flavored Markdown
4. **Parse**: Splits into sections by heading
5. **Cache**: Stores result for 24h
6. **Serve**: Returns only what you ask for

## Troubleshooting

**"Playwright not found"**
```bash
npx playwright install chromium
```

**"ECONNREFUSED" or timeout**
- Site may be blocking headless browsers
- Try `render_js=false` for static sites

**Stale content**
```bash
rm -rf ~/.cache/web2md
```

## License

MIT
