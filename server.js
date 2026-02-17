#!/usr/bin/env node

/**
 * web2md - Local MCP server for token-efficient web fetching
 *
 * Tools:
 *   web_outline  - Get page structure (~200 tokens) - USE FIRST
 *   web_section  - Get specific section(s) by heading
 *   web_content  - Get full page with token cap
 *   web_search   - Search for term within page
 *
 * Features:
 *   - Playwright for JS-heavy SPAs
 *   - Readability for content extraction
 *   - 24h disk cache
 *   - Token estimation
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { JSDOM } from "jsdom";
import { chromium } from "playwright";
import { createHash } from "crypto";
import { mkdir, readFile, writeFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

// === CONFIG ===
const CACHE_DIR = join(homedir(), ".cache", "web2md");
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours
const DEFAULT_MAX_TOKENS = 4000;
const CHARS_PER_TOKEN = 4; // Conservative estimate

// === CACHE ===
async function ensureCacheDir() {
  await mkdir(CACHE_DIR, { recursive: true });
}

function urlToKey(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

async function getCached(url) {
  const key = urlToKey(url);
  const path = join(CACHE_DIR, `${key}.json`);
  try {
    const stats = await stat(path);
    if (Date.now() - stats.mtimeMs > CACHE_TTL_MS) return null;
    const data = await readFile(path, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function setCache(url, data) {
  await ensureCacheDir();
  const key = urlToKey(url);
  const path = join(CACHE_DIR, `${key}.json`);
  await writeFile(path, JSON.stringify(data));
}

// === TURNDOWN ===
function createTurndown() {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  td.use(gfm);
  td.remove(["script", "style", "nav", "footer", "aside", "iframe", "noscript"]);
  return td;
}

// === FETCH ===
async function fetchWithPlaywright(url) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(1000);
    return await page.content();
  } finally {
    await browser.close();
  }
}

async function fetchSimple(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
  });
  return await res.text();
}

// === CONTENT PROCESSING ===
function extractContent(html, url) {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  return {
    title: article?.title || dom.window.document.title || "Untitled",
    content: article?.content || dom.window.document.body?.innerHTML || html,
    byline: article?.byline,
  };
}

function htmlToMarkdown(html) {
  return createTurndown().turndown(html);
}

// === SECTION PARSING ===
function parseIntoSections(markdown) {
  const lines = markdown.split("\n");
  const sections = [];
  let currentSection = { heading: "_intro", level: 0, content: [] };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      if (currentSection.content.length > 0 || currentSection.heading !== "_intro") {
        sections.push({
          heading: currentSection.heading,
          level: currentSection.level,
          content: currentSection.content.join("\n").trim(),
          tokens: Math.ceil(currentSection.content.join("\n").length / CHARS_PER_TOKEN),
        });
      }
      currentSection = {
        heading: headingMatch[2],
        level: headingMatch[1].length,
        content: [],
      };
    } else {
      currentSection.content.push(line);
    }
  }

  if (currentSection.content.length > 0) {
    sections.push({
      heading: currentSection.heading,
      level: currentSection.level,
      content: currentSection.content.join("\n").trim(),
      tokens: Math.ceil(currentSection.content.join("\n").length / CHARS_PER_TOKEN),
    });
  }

  return sections;
}

// === MAIN FETCH + PARSE ===
async function fetchAndParse(url, renderJs = true) {
  const cached = await getCached(url);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  const html = renderJs ? await fetchWithPlaywright(url) : await fetchSimple(url);
  const { title, content, byline } = extractContent(html, url);
  const markdown = htmlToMarkdown(content);
  const sections = parseIntoSections(markdown);
  const totalTokens = Math.ceil(markdown.length / CHARS_PER_TOKEN);

  const result = {
    url,
    title,
    byline,
    markdown,
    sections,
    totalTokens,
    fetchedAt: new Date().toISOString(),
  };

  await setCache(url, result);
  return { ...result, fromCache: false };
}

// === TOOL IMPLEMENTATIONS ===

async function getOutline(url, renderJs = true) {
  const data = await fetchAndParse(url, renderJs);

  const outline = data.sections.map((s) => ({
    heading: s.heading,
    level: s.level,
    tokens: s.tokens,
  }));

  const outlineText = outline
    .map((s) => `${"  ".repeat(Math.max(0, s.level - 1))}- ${s.heading} (~${s.tokens} tokens)`)
    .join("\n");

  return {
    title: data.title,
    url: data.url,
    totalTokens: data.totalTokens,
    sectionCount: data.sections.length,
    outline: outlineText,
    fromCache: data.fromCache,
  };
}

async function getSection(url, headings, renderJs = true) {
  const data = await fetchAndParse(url, renderJs);
  const headingList = Array.isArray(headings) ? headings : [headings];
  const headingLower = headingList.map((h) => h.toLowerCase());

  const matched = data.sections.filter(
    (s) =>
      headingLower.some((h) => s.heading.toLowerCase() === h) ||
      headingLower.some((h) => s.heading.toLowerCase().includes(h))
  );

  if (matched.length === 0) {
    return {
      error: `No sections found matching: ${headingList.join(", ")}`,
      availableSections: data.sections.map((s) => s.heading),
    };
  }

  const content = matched
    .map((s) => `${"#".repeat(s.level || 1)} ${s.heading}\n\n${s.content}`)
    .join("\n\n---\n\n");

  return {
    title: data.title,
    url: data.url,
    sectionsReturned: matched.length,
    tokens: Math.ceil(content.length / CHARS_PER_TOKEN),
    content,
    fromCache: data.fromCache,
  };
}

async function getContent(url, maxTokens = DEFAULT_MAX_TOKENS, renderJs = true) {
  const data = await fetchAndParse(url, renderJs);

  let content = `# ${data.title}\n\nSource: ${data.url}\n\n${data.markdown}`;
  const actualTokens = Math.ceil(content.length / CHARS_PER_TOKEN);

  if (actualTokens > maxTokens) {
    const maxChars = maxTokens * CHARS_PER_TOKEN;
    content = content.slice(0, maxChars);
    const lastPara = content.lastIndexOf("\n\n");
    if (lastPara > maxChars * 0.8) {
      content = content.slice(0, lastPara);
    }
    content += `\n\n---\n*[Truncated: ~${maxTokens} of ${actualTokens} tokens. Use web_section for specific parts.]*`;
  }

  return {
    title: data.title,
    url: data.url,
    totalTokens: actualTokens,
    returnedTokens: Math.min(actualTokens, maxTokens),
    truncated: actualTokens > maxTokens,
    content,
    fromCache: data.fromCache,
  };
}

async function searchInPage(url, query, renderJs = true) {
  const data = await fetchAndParse(url, renderJs);
  const queryLower = query.toLowerCase();

  const matches = data.sections
    .filter((s) => s.content.toLowerCase().includes(queryLower))
    .map((s) => {
      const idx = s.content.toLowerCase().indexOf(queryLower);
      const start = Math.max(0, idx - 150);
      const end = Math.min(s.content.length, idx + query.length + 150);
      return {
        heading: s.heading,
        excerpt: (start > 0 ? "..." : "") + s.content.slice(start, end) + (end < s.content.length ? "..." : ""),
      };
    });

  return {
    title: data.title,
    url: data.url,
    query,
    matchCount: matches.length,
    matches,
    fromCache: data.fromCache,
  };
}

// === MCP SERVER ===
const server = new Server(
  { name: "web2md", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "web_outline",
      description:
        "Get the outline/structure of a webpage. Returns headings with estimated token counts. USE THIS FIRST to understand page structure before fetching content. Very cheap (~200 tokens output).",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch" },
          render_js: {
            type: "boolean",
            default: true,
            description: "Render JavaScript with Playwright (for SPAs). Set false for static sites.",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "web_section",
      description:
        "Get specific section(s) of a webpage by heading name. Use after web_outline to fetch only what you need. Supports partial heading matches.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch" },
          headings: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
            description: "Heading(s) to extract. Partial match supported.",
          },
          render_js: { type: "boolean", default: true },
        },
        required: ["url", "headings"],
      },
    },
    {
      name: "web_content",
      description:
        "Get full page content as markdown. Automatically truncates to max_tokens. Use web_outline + web_section for better efficiency.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch" },
          max_tokens: {
            type: "number",
            default: 4000,
            description: "Maximum tokens to return (default 4000)",
          },
          render_js: { type: "boolean", default: true },
        },
        required: ["url"],
      },
    },
    {
      name: "web_search",
      description:
        "Search for a term within a webpage. Returns matching sections with context excerpts. Useful for finding specific info without loading the entire page.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to search within" },
          query: { type: "string", description: "Search term" },
          render_js: { type: "boolean", default: true },
        },
        required: ["url", "query"],
      },
    },
  ],
}));

server.setRequestHandler("tools/call", async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;
    switch (name) {
      case "web_outline":
        result = await getOutline(args.url, args.render_js ?? true);
        break;
      case "web_section":
        result = await getSection(args.url, args.headings, args.render_js ?? true);
        break;
      case "web_content":
        result = await getContent(args.url, args.max_tokens ?? 4000, args.render_js ?? true);
        break;
      case "web_search":
        result = await searchInPage(args.url, args.query, args.render_js ?? true);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    let text;
    if (name === "web_outline") {
      text = `# ${result.title}\n\nSource: ${result.url}\nTotal: ~${result.totalTokens} tokens | ${result.sectionCount} sections | ${result.fromCache ? "cached" : "fresh fetch"}\n\n## Outline\n\n${result.outline}`;
    } else if (name === "web_section") {
      if (result.error) {
        text = `Error: ${result.error}\n\nAvailable sections:\n${result.availableSections.map((s) => `- ${s}`).join("\n")}`;
      } else {
        text = `# ${result.title}\n\nSource: ${result.url} | ${result.sectionsReturned} section(s) | ~${result.tokens} tokens | ${result.fromCache ? "cached" : "fresh"}\n\n---\n\n${result.content}`;
      }
    } else if (name === "web_content") {
      text = result.content;
    } else if (name === "web_search") {
      if (result.matches.length === 0) {
        text = `No matches for "${result.query}" in ${result.title}`;
      } else {
        text = `# Search: "${result.query}" in ${result.title}\n\n${result.matchCount} match(es) | ${result.fromCache ? "cached" : "fresh"}\n\n${result.matches.map((m) => `## ${m.heading}\n\n${m.excerpt}`).join("\n\n---\n\n")}`;
      }
    }

    return { content: [{ type: "text", text }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("web2md MCP server running");
