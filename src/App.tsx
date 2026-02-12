import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useStdin, useStdout } from "ink";
import type {
  InlineCommentNode,
  IssueComment,
  LoadedPrComments,
  PullRequestReview,
  PrListItem,
  SubmitCommentRequest
} from "./types.js";

type PanelFocus = "list" | "detail";
const HTML_TAG_RE = /<\/?[a-z][a-z0-9-]*(?:\s[^>]*?)?\/?>/gi;
const ADD_COMMENT_ROW: AddCommentRow = {
  key: "add-comment",
  kind: "add-comment",
  label: "Press Enter to add a new comment..."
};

interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  color?: "blue" | "yellow" | "cyan" | "gray" | "white" | "magenta" | "green";
  link?: string;
}

interface MarkdownLine {
  prefix: string;
  spans: InlineSpan[];
  color?: "yellow" | "cyan" | "gray";
  dim?: boolean;
}

interface WrappedBodyLine {
  spans: InlineSpan[];
  color?: "yellow" | "cyan" | "gray";
  dim?: boolean;
}

interface MarkdownRenderOptions {
  commitBaseUrl?: string;
}

interface UnifiedCommentRow {
  key: string;
  commentId: number;
  depth: number;
  subline: string;
  body: string;
  htmlUrl: string;
  createdAt: string;
  author: string;
  location: string;
  kind: "discussion" | "inline" | "review";
}

interface AddCommentRow {
  key: "add-comment";
  kind: "add-comment";
  label: string;
}

type CommentListRow = AddCommentRow | UnifiedCommentRow;

type ComposerMode =
  | null
  | { mode: "top-level" }
  | {
      mode: "reply";
      target: {
        kind: UnifiedCommentRow["kind"];
        id: number;
        author: string;
        htmlUrl: string;
        location: string;
      };
    };

interface SelectorRow {
  key: string;
  headline: string;
  subline: string;
}

interface MouseSequence {
  code: number;
  x: number;
  y: number;
  kind: "M" | "m";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const AUTHOR_COLOR_PALETTE: Array<NonNullable<InlineSpan["color"]>> = [
  "cyan",
  "green",
  "magenta",
  "blue",
  "yellow"
];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function authorColor(login: string): NonNullable<InlineSpan["color"]> {
  if (!login) {
    return "white";
  }

  return AUTHOR_COLOR_PALETTE[hashString(login.toLowerCase()) % AUTHOR_COLOR_PALETTE.length];
}

function safeCodePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) {
    return "";
  }

  try {
    return String.fromCodePoint(value);
  } catch {
    return "";
  }
}

function decodeHtmlEntities(input: string): string {
  let output = input;
  for (let i = 0; i < 4; i += 1) {
    const before = output;
    output = output
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'")
      .replace(/&nbsp;/gi, " ")
      .replace(/&#(\d+);/g, (_m, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
      .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) =>
        safeCodePoint(Number.parseInt(hex, 16))
      );
    if (output === before) {
      break;
    }
  }

  return output;
}

function truncateText(input: string, maxWidth: number): string {
  const clean = input.replace(/\s+/g, " ").trim();
  if (clean.length <= maxWidth) {
    return clean;
  }

  if (maxWidth <= 3) {
    return clean.slice(0, Math.max(0, maxWidth));
  }

  return `${clean.slice(0, maxWidth - 3)}...`;
}

function previewBody(body: string): string {
  const normalized = normalizeBodyForDisplay(body).replace(/\s+/g, " ").trim();
  return normalized || "(no body)";
}

function normalizeBodyForDisplay(input: string): string {
  if (!input) {
    return "(no body)";
  }

  let output = decodeHtmlEntities(input);
  output = output.replace(/\r\n/g, "\n");
  output = output.replace(/<br\s*\/?>/gi, "\n");
  output = output.replace(/<(div|section|article|header|footer|aside)[^>]*>/gi, "\n");
  output = output.replace(/<\/(div|section|article|header|footer|aside)>\s*/gi, "\n");
  output = output.replace(/<\/p>\s*/gi, "\n\n");
  output = output.replace(/<p[^>]*>/gi, "");
  output = output.replace(/<summary[^>]*>(.*?)<\/summary>/gi, "\n**$1**\n");
  output = output.replace(/<(details|summary)[^>]*>/gi, "\n");
  output = output.replace(/<\/(details|summary)>\s*/gi, "\n");
  output = output.replace(/<blockquote[^>]*>/gi, "\n> ");
  output = output.replace(/<\/blockquote>\s*/gi, "\n");
  output = output.replace(/<li[^>]*>/gi, "- ");
  output = output.replace(/<\/li>\s*/gi, "\n");
  output = output.replace(/<(ul|ol)[^>]*>/gi, "\n");
  output = output.replace(/<\/(ul|ol)>\s*/gi, "\n");
  output = output.replace(/<(h[1-6])[^>]*>/gi, "\n## ");
  output = output.replace(/<\/h[1-6]>\s*/gi, "\n");
  output = output.replace(/<(strong|b)[^>]*>/gi, "**");
  output = output.replace(/<\/(strong|b)>/gi, "**");
  output = output.replace(/<(em|i)[^>]*>/gi, "*");
  output = output.replace(/<\/(em|i)>/gi, "*");
  output = output.replace(/<code[^>]*>/gi, "`");
  output = output.replace(/<\/code>/gi, "`");
  output = output.replace(/<pre[^>]*>/gi, "```\n");
  output = output.replace(/<\/pre>/gi, "\n```");
  output = output.replace(
    /<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi,
    (_match, href: string, label: string) => {
      const cleanLabel = decodeHtmlEntities(label.replace(HTML_TAG_RE, ""));
      return `[${cleanLabel || href}](${href})`;
    }
  );
  output = decodeHtmlEntities(output);
  output = output.replace(HTML_TAG_RE, "");
  output = decodeHtmlEntities(output);
  output = output.replace(/\n{3,}/g, "\n\n").trim();
  return output || "(no body)";
}

function author(login?: string | null): string {
  return login || "ghost";
}

function fmtDate(iso?: string | null): string {
  if (!iso) {
    return "unknown time";
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function fmtTimeOfDay(timestamp?: number | null): string {
  if (!timestamp) {
    return "unknown";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function fmtRelativeOrAbsolute(iso?: string | null): string {
  if (!iso) {
    return "unknown time";
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const deltaMs = Date.now() - date.getTime();
  if (deltaMs >= 0 && deltaMs < 60 * 60 * 1000) {
    const minutes = Math.max(1, Math.floor(deltaMs / 60000));
    return `${minutes}min ago`;
  }

  return fmtDate(iso);
}

function toTimestamp(iso?: string | null): number {
  if (!iso) {
    return 0;
  }

  const timestamp = new Date(iso).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function parseMouseSequences(chunk: string): MouseSequence[] {
  const events: MouseSequence[] = [];
  const regex = /\u001B\[<(\d+);(\d+);(\d+)([mM])/g;
  let match = regex.exec(chunk);

  while (match) {
    events.push({
      code: Number.parseInt(match[1], 10),
      x: Number.parseInt(match[2], 10),
      y: Number.parseInt(match[3], 10),
      kind: match[4] === "m" ? "m" : "M"
    });
    match = regex.exec(chunk);
  }

  return events;
}

function normalizeSingleLineLabel(value: string): string {
  const cleaned = value
    .replace(/\r\n/g, "\n")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || "unknown";
}

function normalizeComposeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function sanitizeComposeInput(input: string): string {
  if (!input) {
    return "";
  }

  let output = normalizeComposeNewlines(input);
  // OSC sequences
  output = output.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
  // CSI sequences
  output = output.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  // Two-byte escapes
  output = output.replace(/\u001b[@-_]/g, "");
  // Orphaned mouse chunks where ESC was split/lost
  output = output.replace(/\[<\d+;\d+;\d+[mM]/g, "");
  // Remaining controls except tab/newline
  output = output.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "");
  return output;
}

function appendTextWithCommitLinks(
  input: string,
  target: InlineSpan[],
  options: MarkdownRenderOptions
): void {
  if (!input) {
    return;
  }

  const commitBaseUrl = options.commitBaseUrl?.replace(/\/+$/, "");
  if (!commitBaseUrl) {
    target.push({ text: input });
    return;
  }

  // 7-40 hex chars with at least one letter to avoid matching plain numbers.
  const commit = /\b(?=[0-9a-f]{7,40}\b)(?=[0-9a-f]*[a-f])[0-9a-f]+\b/gi;
  let last = 0;
  let match = commit.exec(input);

  while (match) {
    if (match.index > last) {
      target.push({ text: input.slice(last, match.index) });
    }

    const hash = match[0];
    target.push({
      text: hash,
      color: "blue",
      underline: true,
      link: `${commitBaseUrl}/commit/${hash}`
    });

    last = match.index + hash.length;
    match = commit.exec(input);
  }

  if (last < input.length) {
    target.push({ text: input.slice(last) });
  }
}

function parseInlineSpans(input: string, options: MarkdownRenderOptions = {}): InlineSpan[] {
  const token = /(\[[^\]]+\]\(([^)]+)\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|_[^_]+_)/g;
  const spans: InlineSpan[] = [];
  let lastIndex = 0;
  let match = token.exec(input);

  while (match) {
    if (match.index > lastIndex) {
      appendTextWithCommitLinks(input.slice(lastIndex, match.index), spans, options);
    }

    const value = match[0];
    if (value.startsWith("[") && value.endsWith(")")) {
      const linkMatch = value.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        spans.push({ text: linkMatch[1], color: "blue", underline: true });
        spans.push({ text: ` (${linkMatch[2]})`, dim: true });
      } else {
        spans.push({ text: value });
      }
    } else if (value.startsWith("**") && value.endsWith("**")) {
      spans.push({ text: value.slice(2, -2), bold: true });
    } else if (value.startsWith("`") && value.endsWith("`")) {
      spans.push({ text: value.slice(1, -1), color: "yellow" });
    } else if (
      (value.startsWith("*") && value.endsWith("*")) ||
      (value.startsWith("_") && value.endsWith("_"))
    ) {
      spans.push({ text: value.slice(1, -1), italic: true });
    } else {
      spans.push({ text: value });
    }

    lastIndex = match.index + value.length;
    match = token.exec(input);
  }

  if (lastIndex < input.length) {
    appendTextWithCommitLinks(input.slice(lastIndex), spans, options);
  }

  return spans;
}

function markdownToLines(text: string, options: MarkdownRenderOptions = {}): MarkdownLine[] {
  const sourceLines = normalizeBodyForDisplay(text || "(no body)").split(/\r?\n/);
  const output: MarkdownLine[] = [];
  let inFence = false;

  for (const sourceLine of sourceLines) {
    const trimmed = sourceLine.trim();

    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      output.push({
        prefix: "",
        spans: [{ text: sourceLine }],
        color: "yellow"
      });
      continue;
    }

    if (trimmed.length === 0) {
      output.push({ prefix: "", spans: [{ text: "" }] });
      continue;
    }

    const heading = sourceLine.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      output.push({
        prefix: "",
        spans: parseInlineSpans(heading[2], options),
        color: "cyan"
      });
      continue;
    }

    const quote = sourceLine.match(/^\s*>\s?(.*)$/);
    if (quote) {
      output.push({
        prefix: "> ",
        spans: parseInlineSpans(quote[1], options),
        dim: true
      });
      continue;
    }

    const bullet = sourceLine.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      output.push({
        prefix: "• ",
        spans: parseInlineSpans(bullet[1], options)
      });
      continue;
    }

    const numbered = sourceLine.match(/^\s*(\d+)\.\s+(.*)$/);
    if (numbered) {
      output.push({
        prefix: `${numbered[1]}. `,
        spans: parseInlineSpans(numbered[2], options)
      });
      continue;
    }

    output.push({
      prefix: "",
      spans: parseInlineSpans(sourceLine, options)
    });
  }

  return output;
}

function InlineText({ spans }: { spans: InlineSpan[] }): JSX.Element {
  const OSC = "\u001B]8;;";
  const BEL = "\u0007";

  const hyperlink = (text: string, url: string): string => {
    return `${OSC}${url}${BEL}${text}${OSC}${BEL}`;
  };

  return (
    <>
      {spans.map((span, idx) => (
        <Text
          key={`span-${idx}`}
          bold={Boolean(span.bold)}
          italic={Boolean(span.italic)}
          underline={Boolean(span.underline)}
          dimColor={Boolean(span.dim)}
          color={span.color}
        >
          {span.link ? hyperlink(span.text, span.link) : span.text}
        </Text>
      ))}
    </>
  );
}

function lineRef(path: string | null, line: number | null, original: number | null): string {
  if (!path) {
    return "general";
  }

  const resolved = line ?? original;
  if (!resolved) {
    return path;
  }

  return `${path}:${resolved}`;
}

function countLeadingSpaces(text: string): number {
  let count = 0;
  while (count < text.length && text[count] === " ") {
    count += 1;
  }
  return count;
}

function sameInlineStyle(a: InlineSpan, b: InlineSpan): boolean {
  return (
    Boolean(a.bold) === Boolean(b.bold) &&
    Boolean(a.italic) === Boolean(b.italic) &&
    Boolean(a.underline) === Boolean(b.underline) &&
    Boolean(a.dim) === Boolean(b.dim) &&
    a.color === b.color
  );
}

function pushWrappedSpan(target: InlineSpan[], next: InlineSpan): void {
  if (!next.text) {
    return;
  }

  const last = target[target.length - 1];
  if (last && sameInlineStyle(last, next)) {
    last.text += next.text;
    return;
  }

  target.push({ ...next });
}

function spanTextLength(spans: InlineSpan[]): number {
  return spans.reduce((sum, span) => sum + span.text.length, 0);
}

function trimStyledSpans(spans: InlineSpan[], maxChars: number): InlineSpan[] {
  if (maxChars <= 0) {
    return [];
  }

  const total = spanTextLength(spans);
  if (total <= maxChars) {
    return spans.map((span) => ({ ...span }));
  }

  if (maxChars <= 3) {
    return [{ text: ".".repeat(maxChars), dim: true }];
  }

  const keep = maxChars - 3;
  const output: InlineSpan[] = [];
  let remaining = keep;

  for (const span of spans) {
    if (remaining <= 0) {
      break;
    }

    if (span.text.length <= remaining) {
      pushWrappedSpan(output, { ...span });
      remaining -= span.text.length;
      continue;
    }

    pushWrappedSpan(output, { ...span, text: span.text.slice(0, remaining) });
    remaining = 0;
  }

  pushWrappedSpan(output, { text: "...", dim: true });
  return output;
}

function wrapMarkdownLine(line: MarkdownLine, baseIndent: number, wrapWidth: number): WrappedBodyLine[] {
  const plainText = line.spans.map((span) => span.text).join("");
  const firstPrefix = `${" ".repeat(baseIndent)}${line.prefix}`;
  const sourceSpans: InlineSpan[] = [{ text: firstPrefix }, ...line.spans];
  const lineLeading = countLeadingSpaces(`${line.prefix}${plainText}`);
  const continuationBase = lineLeading > 0 ? lineLeading : line.prefix.length;
  const continuationIndent = " ".repeat(Math.max(0, baseIndent + continuationBase));
  const safeWidth = Math.max(24, wrapWidth);
  const continuationPrefix = continuationIndent.slice(0, Math.max(0, safeWidth - 1));
  const output: WrappedBodyLine[] = [];
  let current: WrappedBodyLine = { spans: [], color: line.color, dim: line.dim };
  let currentWidth = 0;

  const startNewLine = (): void => {
    output.push(current);
    current = { spans: [], color: line.color, dim: line.dim };
    currentWidth = 0;
    if (continuationPrefix) {
      pushWrappedSpan(current.spans, { text: continuationPrefix });
      currentWidth += continuationPrefix.length;
    }
  };

  for (const span of sourceSpans) {
    let remaining = span.text;
    const style: InlineSpan = {
      text: "",
      bold: span.bold,
      italic: span.italic,
      underline: span.underline,
      dim: span.dim,
      color: span.color
    };

    while (remaining.length > 0) {
      let room = safeWidth - currentWidth;
      if (room <= 0) {
        startNewLine();
        room = safeWidth - currentWidth;
      }

      if (remaining.length <= room) {
        pushWrappedSpan(current.spans, { ...style, text: remaining });
        currentWidth += remaining.length;
        remaining = "";
        continue;
      }

      let splitAt = remaining.slice(0, room).lastIndexOf(" ");
      if (splitAt <= 0) {
        splitAt = room;
      } else {
        splitAt += 1;
      }

      const chunk = remaining.slice(0, splitAt);
      pushWrappedSpan(current.spans, { ...style, text: chunk });
      currentWidth += chunk.length;
      remaining = remaining.slice(splitAt);
      if (remaining.length > 0) {
        startNewLine();
      }
    }
  }

  output.push(current);
  return output;
}

function countWrappedMarkdownLines(
  text: string,
  indent: number,
  wrapWidth: number,
  options: MarkdownRenderOptions = {}
): number {
  return markdownToLines(text, options).flatMap((line) => wrapMarkdownLine(line, indent, wrapWidth)).length;
}

function countWrappedPlainLines(text: string, wrapWidth: number): number {
  const safeWidth = Math.max(1, wrapWidth);
  return normalizeComposeNewlines(text || "").split("\n").reduce((sum, line) => {
    if (line.length === 0) {
      return sum + 1;
    }

    return sum + Math.max(1, Math.ceil(line.length / safeWidth));
  }, 0);
}

function wrapPlainLines(text: string, wrapWidth: number): string[] {
  const safeWidth = Math.max(1, wrapWidth);
  const source = normalizeComposeNewlines(text || "").split("\n");
  const output: string[] = [];

  for (const raw of source) {
    if (raw.length === 0) {
      output.push("");
      continue;
    }

    let remaining = raw;
    while (remaining.length > safeWidth) {
      output.push(remaining.slice(0, safeWidth));
      remaining = remaining.slice(safeWidth);
    }
    output.push(remaining);
  }

  return output.length > 0 ? output : [""];
}

function formatCommentListLine({
  selected,
  depth,
  authorName,
  preview,
  when,
  width
}: {
  selected: boolean;
  depth: number;
  authorName: string;
  preview: string;
  when: string;
  width: number;
}): InlineSpan[] {
  const safeWidth = Math.max(8, width);
  const safeWhen = truncateText(when, Math.max(2, safeWidth - 2));
  const maxLeft = Math.max(1, safeWidth - safeWhen.length - 1);
  const leftSpans: InlineSpan[] = [
    { text: selected ? "> " : "  ", color: selected ? "yellow" : "gray" },
    { text: " ".repeat(Math.max(0, depth) * 2) },
    { text: authorName, color: authorColor(authorName), bold: true },
    { text: " " },
    { text: preview, dim: depth > 0 }
  ];

  const trimmedLeft = trimStyledSpans(leftSpans, maxLeft);
  const gap = Math.max(1, safeWidth - spanTextLength(trimmedLeft) - safeWhen.length);
  return [
    ...trimmedLeft,
    { text: " ".repeat(gap) },
    { text: safeWhen, color: "gray", dim: true }
  ];
}

function Body({
  text,
  indent = 0,
  maxLines,
  startLine = 0,
  wrapWidth,
  renderOptions
}: {
  text: string;
  indent?: number;
  maxLines?: number;
  startLine?: number;
  wrapWidth: number;
  renderOptions?: MarkdownRenderOptions;
}): JSX.Element {
  const wrapped = markdownToLines(text, renderOptions).flatMap((line) =>
    wrapMarkdownLine(line, indent, wrapWidth)
  );
  const hasWrapped = wrapped.length > 0;
  const safeStart = hasWrapped ? clamp(startLine, 0, wrapped.length - 1) : 0;

  let clipped: WrappedBodyLine[];
  let hidden = 0;
  let padLines = 0;
  if (typeof maxLines === "number") {
    const safeMax = Math.max(1, maxLines);
    const hiddenCandidate = Math.max(0, wrapped.length - (safeStart + safeMax));
    const contentLimit = hiddenCandidate > 0 ? Math.max(0, safeMax - 1) : safeMax;
    clipped = wrapped.slice(safeStart, safeStart + contentLimit);
    hidden = hiddenCandidate;
    padLines = safeMax - clipped.length - (hidden > 0 ? 1 : 0);
  } else {
    clipped = wrapped.slice(safeStart);
    hidden = Math.max(0, wrapped.length - (safeStart + clipped.length));
  }

  return (
    <Box flexDirection="column">
      {clipped.map((line, idx) => (
        <Text
          key={`body-${idx}`}
          color={line.color}
          dimColor={Boolean(line.dim)}
          wrap="wrap"
        >
          {""}
          <InlineText spans={line.spans} />
        </Text>
      ))}
      {hidden > 0 && (
        <Text dimColor wrap="wrap">
          {`${" ".repeat(indent)}... (${hidden} more line${hidden === 1 ? "" : "s"})`}
        </Text>
      )}
      {Array.from({ length: Math.max(0, padLines) }).map((_, idx) => (
        <Text key={`body-pad-${idx}`} wrap="wrap">
          {" "}
        </Text>
      ))}
    </Box>
  );
}

function PlainBody({
  text,
  maxLines,
  startLine = 0,
  wrapWidth,
  dim = false,
  leftPad = 1
}: {
  text: string;
  maxLines?: number;
  startLine?: number;
  wrapWidth: number;
  dim?: boolean;
  leftPad?: number;
}): JSX.Element {
  const pad = Math.max(0, leftPad);
  const contentWidth = Math.max(1, wrapWidth - pad);
  const wrapped = wrapPlainLines(text, contentWidth);
  const hasWrapped = wrapped.length > 0;
  const safeStart = hasWrapped ? clamp(startLine, 0, wrapped.length - 1) : 0;

  let clipped: string[];
  let hidden = 0;
  let padLines = 0;
  if (typeof maxLines === "number") {
    const safeMax = Math.max(1, maxLines);
    const hiddenCandidate = Math.max(0, wrapped.length - (safeStart + safeMax));
    // Always render at least one content row. If we only have one row budget,
    // skip the "... more lines" indicator instead of hiding all content.
    const showHiddenIndicator = hiddenCandidate > 0 && safeMax > 1;
    const contentLimit = showHiddenIndicator ? safeMax - 1 : safeMax;
    clipped = wrapped.slice(safeStart, safeStart + contentLimit);
    hidden = showHiddenIndicator ? hiddenCandidate : 0;
    padLines = safeMax - clipped.length - (hidden > 0 ? 1 : 0);
  } else {
    clipped = wrapped.slice(safeStart);
    hidden = Math.max(0, wrapped.length - (safeStart + clipped.length));
  }

  return (
    <Box flexDirection="column">
      {clipped.map((line, idx) => {
        const safeLine = line.length > 0 ? line : " ";
        const rendered = safeLine.slice(0, contentWidth).padEnd(contentWidth, " ");
        return (
          <Text key={`plain-body-${idx}`} dimColor={dim} wrap="truncate-end">
            {`${" ".repeat(pad)}${rendered}`}
          </Text>
        );
      })}
      {hidden > 0 && (
        <Text dimColor wrap="truncate-end">
          {`${" ".repeat(pad)}... (${hidden} more line${hidden === 1 ? "" : "s"})`
            .slice(0, wrapWidth)
            .padEnd(wrapWidth, " ")}
        </Text>
      )}
      {Array.from({ length: Math.max(0, padLines) }).map((_, idx) => (
        <Text key={`plain-body-pad-${idx}`} wrap="truncate-end">
          {" ".repeat(Math.max(1, wrapWidth))}
        </Text>
      ))}
    </Box>
  );
}

function latestTimestamp(node: InlineCommentNode): number {
  let latest = toTimestamp(node.comment.created_at);
  for (const child of node.children) {
    latest = Math.max(latest, latestTimestamp(child));
  }
  return latest;
}

function discussionRow(comment: IssueComment): UnifiedCommentRow {
  return {
    key: `discussion-${comment.id}`,
    commentId: comment.id,
    depth: 0,
    subline: previewBody(comment.body),
    body: comment.body || "(no body)",
    htmlUrl: comment.html_url,
    createdAt: comment.created_at,
    author: author(comment.user?.login),
    location: "general",
    kind: "discussion"
  };
}

function inlineRows(node: InlineCommentNode, depth: number): UnifiedCommentRow[] {
  const row: UnifiedCommentRow = {
    key: `inline-${node.comment.id}`,
    commentId: node.comment.id,
    depth,
    subline: previewBody(node.comment.body),
    body: node.comment.body || "(no body)",
    htmlUrl: node.comment.html_url,
    createdAt: node.comment.created_at,
    author: author(node.comment.user?.login),
    location: lineRef(node.comment.path, node.comment.line, node.comment.original_line),
    kind: "inline"
  };

  const children = node.children.flatMap((child) => inlineRows(child, depth + 1));
  return [row, ...children];
}

function reviewRow(review: PullRequestReview): UnifiedCommentRow {
  const submittedAt = review.submitted_at || "";
  return {
    key: `review-${review.id}`,
    commentId: review.id,
    depth: 0,
    subline: previewBody(review.body || "(no body)"),
    body: review.body || "(no body)",
    htmlUrl: review.html_url,
    createdAt: submittedAt,
    author: author(review.user?.login),
    location: `review ${review.state.toLowerCase()}`,
    kind: "review"
  };
}

function buildUnifiedRows(data: LoadedPrComments): UnifiedCommentRow[] {
  const grouped: Array<{ sort: number; rows: UnifiedCommentRow[] }> = [];
  const reviewsById = new Map<number, PullRequestReview>();
  const inlineThreadsByReviewId = new Map<number, InlineCommentNode[]>();

  for (const review of data.reviews) {
    reviewsById.set(review.id, review);
  }

  for (const comment of data.issueComments) {
    grouped.push({
      sort: toTimestamp(comment.created_at),
      rows: [discussionRow(comment)]
    });
  }

  for (const thread of data.inlineThreads) {
    const reviewId = thread.root.comment.pull_request_review_id ?? null;
    if (reviewId && reviewsById.has(reviewId)) {
      const existing = inlineThreadsByReviewId.get(reviewId) || [];
      existing.push(thread.root);
      inlineThreadsByReviewId.set(reviewId, existing);
      continue;
    }

    grouped.push({
      sort: latestTimestamp(thread.root),
      rows: inlineRows(thread.root, 0)
    });
  }

  for (const review of data.reviews) {
    const attachedInlineRoots = inlineThreadsByReviewId.get(review.id) || [];
    attachedInlineRoots.sort((a, b) => latestTimestamp(a) - latestTimestamp(b));
    const nestedInlineRows = attachedInlineRoots.flatMap((root) => inlineRows(root, 1));
    const groupSort = attachedInlineRoots.reduce(
      (latest, root) => Math.max(latest, latestTimestamp(root)),
      toTimestamp(review.submitted_at)
    );

    grouped.push({
      sort: groupSort,
      rows: [reviewRow(review), ...nestedInlineRows]
    });
  }

  grouped.sort((a, b) => a.sort - b.sort);
  return grouped.flatMap((item) => item.rows);
}

export function PrSelector({
  repoName,
  prs,
  preferredPrNumber,
  autoRefreshIntervalMs,
  isRefreshing,
  error,
  onRefresh,
  onSelect,
  onExitRequest
}: {
  repoName: string;
  prs: PrListItem[];
  preferredPrNumber: number | null;
  autoRefreshIntervalMs: number;
  isRefreshing: boolean;
  error: string | null;
  onRefresh: () => void;
  onSelect: (prNumber: number) => void;
  onExitRequest: () => void;
}): JSX.Element {
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();

  const initialIndex = useMemo(() => {
    if (preferredPrNumber === null) {
      return 0;
    }

    const found = prs.findIndex((pr) => pr.number === preferredPrNumber);
    return found >= 0 ? found : 0;
  }, [preferredPrNumber, prs]);

  const [activeIndex, setActiveIndex] = useState(initialIndex);

  useEffect(() => {
    setActiveIndex(initialIndex);
  }, [initialIndex]);

  useEffect(() => {
    if (!isRawModeSupported) {
      onExitRequest();
    }
  }, [isRawModeSupported, onExitRequest]);

  const maxIndex = Math.max(0, prs.length - 1);
  const safeIndex = clamp(activeIndex, 0, maxIndex);
  const terminalRows = stdout.rows || 24;
  const terminalCols = stdout.columns || 80;
  const listWrapWidth = Math.max(24, terminalCols - 8);
  const appWrapWidth = Math.max(16, terminalCols - 2);
  const titleText = `gh-feed  ${repoName}`;
  const statusText = `Open PRs: ${prs.length}${isRefreshing ? " | refreshing..." : ""}`;
  const refreshEvery = autoRefreshIntervalMs % 1000 === 0
    ? `${autoRefreshIntervalMs / 1000}s`
    : `${(autoRefreshIntervalMs / 1000).toFixed(1)}s`;
  const helpText = isRawModeSupported
    ? `Keys: up/down or j/k move, Enter open PR, r refresh list, q quit | auto refresh ${refreshEvery}`
    : "Non-interactive terminal detected: rendered once and exiting.";
  const topHeaderLines =
    countWrappedPlainLines(titleText, appWrapWidth) +
    countWrappedPlainLines(statusText, appWrapWidth) +
    (error ? countWrappedPlainLines(error, appWrapWidth) : 0);
  const helpLines = countWrappedPlainLines(helpText, appWrapWidth);
  const listPanelHeight = Math.max(8, terminalRows - (topHeaderLines + helpLines + 5));
  const listContentBudget = Math.max(1, listPanelHeight - 3);
  const listWindow = clamp(
    Math.max(2, Math.floor(listContentBudget / 2) + 1),
    2,
    Math.max(2, prs.length)
  );
  const listPageStep = Math.max(1, listWindow - 1);
  const listStart = clamp(
    safeIndex - Math.floor(listWindow / 2),
    0,
    Math.max(0, prs.length - listWindow)
  );

  const visibleRows = useMemo(() => {
    return prs.slice(listStart, listStart + listWindow).map((pr, idx) => {
      const absolute = listStart + idx;
      const selected = absolute === safeIndex;
      const row: SelectorRow = {
        key: `selector-${pr.number}`,
        headline: `${selected ? ">" : " "} [${absolute + 1}] #${pr.number} ${pr.title}`,
        subline: `    ${pr.headRefName} -> ${pr.baseRefName}  updated ${fmtRelativeOrAbsolute(pr.updatedAt)}`
      };

      return {
        row,
        selected,
        headlineLines: wrapMarkdownLine({ prefix: "", spans: [{ text: row.headline }] }, 0, listWrapWidth),
        sublineLines: wrapMarkdownLine({ prefix: "", spans: [{ text: row.subline }] }, 0, listWrapWidth)
      };
    });
  }, [prs, listStart, listWindow, safeIndex, listWrapWidth]);

  const renderedRows = useMemo(() => {
    if (prs.length === 0) {
      return [];
    }

    const output: typeof visibleRows = [];
    let remaining = listContentBudget;
    for (const item of visibleRows) {
      if (remaining <= 0) {
        break;
      }

      const headlineLines = item.headlineLines.slice(0, remaining);
      remaining -= headlineLines.length;
      const sublineLines = remaining > 0 ? item.sublineLines.slice(0, remaining) : [];
      remaining -= sublineLines.length;

      if (headlineLines.length === 0 && sublineLines.length === 0) {
        break;
      }

      output.push({
        ...item,
        headlineLines,
        sublineLines
      });
    }

    return output;
  }, [prs.length, listContentBudget, visibleRows]);

  useInput(
    (input, key) => {
      if (input === "q" || key.escape || (key.ctrl && input === "c")) {
        onExitRequest();
        return;
      }

      if (input === "r") {
        onRefresh();
        return;
      }

      if (key.return && prs[safeIndex]) {
        onSelect(prs[safeIndex].number);
        return;
      }

      if (input === "g") {
        setActiveIndex(0);
        return;
      }

      if (input === "G") {
        setActiveIndex(maxIndex);
        return;
      }

      if ((key as { pageDown?: boolean }).pageDown) {
        setActiveIndex((prev) => clamp(prev + listPageStep, 0, maxIndex));
        return;
      }

      if ((key as { pageUp?: boolean }).pageUp) {
        setActiveIndex((prev) => clamp(prev - listPageStep, 0, maxIndex));
        return;
      }

      if (key.downArrow || input === "j") {
        setActiveIndex((prev) => clamp(prev + 1, 0, maxIndex));
        return;
      }

      if (key.upArrow || input === "k") {
        setActiveIndex((prev) => clamp(prev - 1, 0, maxIndex));
      }
    },
    { isActive: Boolean(isRawModeSupported) }
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="green" wrap="wrap">
        {titleText}
      </Text>
      <Text dimColor wrap="wrap">
        {statusText}
      </Text>
      {error && (
        <Text color="red" wrap="wrap">
          {error}
        </Text>
      )}

      <Box marginTop={1} flexDirection="column" borderStyle="round" paddingX={1} height={listPanelHeight}>
        <Text color="cyan" wrap="wrap">
          Select Pull Request
        </Text>
        {prs.length === 0 ? (
          <Text dimColor wrap="wrap">
            No open pull requests found. Press r to refresh, or q to quit.
          </Text>
        ) : (
          renderedRows.map((item) => (
            <Box key={item.row.key} flexDirection="column">
              {item.headlineLines.map((line, lineIdx) => (
                <Text
                  key={`selector-headline-${item.row.key}-${lineIdx}`}
                  color={item.selected ? "yellow" : "white"}
                  wrap="wrap"
                >
                  {""}
                  <InlineText spans={line.spans} />
                </Text>
              ))}
              {item.sublineLines.map((line, lineIdx) => (
                <Text key={`selector-subline-${item.row.key}-${lineIdx}`} dimColor wrap="wrap">
                  {""}
                  <InlineText spans={line.spans} />
                </Text>
              ))}
            </Box>
          ))
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor wrap="wrap">
          {helpText}
        </Text>
      </Box>
    </Box>
  );
}

export function CommentsViewer({
  data,
  openPrCount,
  onExitRequest,
  onBackToPrSelection,
  onSubmitComment,
  autoRefreshIntervalMs,
  isRefreshing,
  lastUpdatedAt,
  refreshError
}: {
  data: LoadedPrComments;
  openPrCount: number;
  onExitRequest: () => void;
  onBackToPrSelection: () => void;
  onSubmitComment: (request: SubmitCommentRequest) => Promise<void>;
  autoRefreshIntervalMs: number;
  isRefreshing: boolean;
  lastUpdatedAt: number | null;
  refreshError: string | null;
}): JSX.Element {
  const { isRawModeSupported, stdin } = useStdin();
  const { stdout } = useStdout();
  const rows = useMemo(() => buildUnifiedRows(data), [data]);
  const listRows = useMemo<CommentListRow[]>(() => [...rows, ADD_COMMENT_ROW], [rows]);
  const [panelFocus, setPanelFocus] = useState<PanelFocus>("list");
  const [mouseCaptureEnabled, setMouseCaptureEnabled] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const [detailOffset, setDetailOffset] = useState(0);
  const [composerMode, setComposerMode] = useState<ComposerMode>(null);
  const [composerBody, setComposerBody] = useState("");
  const [composerError, setComposerError] = useState<string | null>(null);
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);
  const panelFocusRef = useRef<PanelFocus>("list");
  const pendingComposerRef = useRef<ComposerMode>(null);
  const submitComposerRef = useRef<() => Promise<void>>(async () => undefined);
  const commitBaseUrl = `https://github.com/${data.repo.nameWithOwner}`;

  const maxIndex = Math.max(0, listRows.length - 1);
  const safeActiveIndex = clamp(activeIndex, 0, maxIndex);
  const activeListRow = listRows[safeActiveIndex] || ADD_COMMENT_ROW;
  const selectedRow = activeListRow.kind === "add-comment" ? null : activeListRow;

  const openTopLevelComposer = useCallback((): void => {
    const nextComposer: ComposerMode = { mode: "top-level" };
    pendingComposerRef.current = nextComposer;
    setComposerMode(nextComposer);
    setComposerBody("");
    setComposerError(null);
    setDetailOffset(0);
    panelFocusRef.current = "detail";
    setPanelFocus("detail");
  }, []);

  const openReplyComposer = useCallback((row: UnifiedCommentRow): void => {
    const nextComposer: ComposerMode = {
      mode: "reply",
      target: {
        kind: row.kind,
        id: row.commentId,
        author: row.author,
        htmlUrl: row.htmlUrl,
        location: row.location
      }
    };
    pendingComposerRef.current = nextComposer;
    setComposerMode(nextComposer);
    setComposerBody("");
    setComposerError(null);
    setDetailOffset(0);
    panelFocusRef.current = "detail";
    setPanelFocus("detail");
  }, []);

  const closeComposer = useCallback((): void => {
    if (isSubmittingComment) {
      return;
    }

    setComposerMode(null);
    pendingComposerRef.current = null;
    setComposerBody("");
    setComposerError(null);
    setDetailOffset(0);
    panelFocusRef.current = "list";
    setPanelFocus("list");
  }, [isSubmittingComment]);

  const submitComposer = useCallback(async (): Promise<void> => {
    const activeComposer = composerMode ?? pendingComposerRef.current;
    if (!activeComposer || isSubmittingComment) {
      return;
    }

    const body = normalizeComposeNewlines(composerBody).trim();
    if (!body) {
      setComposerError("Comment body cannot be empty.");
      return;
    }

    const request: SubmitCommentRequest =
      activeComposer.mode === "top-level"
        ? {
            mode: "top-level",
            body
          }
        : {
            mode: "reply",
            body,
            target: {
              kind: activeComposer.target.kind,
              id: activeComposer.target.id,
              author: activeComposer.target.author,
              htmlUrl: activeComposer.target.htmlUrl
            }
          };

    setIsSubmittingComment(true);
    setComposerError(null);
    try {
      await onSubmitComment(request);
      setComposerMode(null);
      pendingComposerRef.current = null;
      setComposerBody("");
      setDetailOffset(0);
      panelFocusRef.current = "list";
      setPanelFocus("list");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setComposerError(`Failed to submit comment: ${message}`);
    } finally {
      setIsSubmittingComment(false);
    }
  }, [composerBody, composerMode, isSubmittingComment, onSubmitComment]);

  useEffect(() => {
    submitComposerRef.current = submitComposer;
  }, [submitComposer]);

  const startReplyForSelection = useCallback((): void => {
    if (!selectedRow) {
      return;
    }

    openReplyComposer(selectedRow);
  }, [openReplyComposer, selectedRow]);

  useEffect(() => {
    setActiveIndex((prev) => clamp(prev, 0, maxIndex));
  }, [maxIndex]);

  useEffect(() => {
    setDetailOffset(0);
  }, [
    safeActiveIndex,
    activeListRow.key,
    composerMode?.mode,
    composerMode && composerMode.mode === "reply" ? composerMode.target.id : 0
  ]);

  useEffect(() => {
    panelFocusRef.current = panelFocus;
  }, [panelFocus]);

  useEffect(() => {
    if (composerMode || panelFocus !== "detail") {
      return;
    }

    if (activeListRow.kind === "add-comment") {
      openTopLevelComposer();
    }
  }, [activeListRow.kind, composerMode, openTopLevelComposer, panelFocus]);

  useEffect(() => {
    if (!isRawModeSupported) {
      onExitRequest();
    }
  }, [isRawModeSupported, onExitRequest]);

  const terminalRows = stdout.rows || 24;
  const terminalCols = stdout.columns || 80;
  const listWrapWidth = Math.max(24, terminalCols - 10);
  const detailWrapWidth = Math.max(24, terminalCols - 8);
  const appWrapWidth = Math.max(16, terminalCols - 2);
  const refreshEvery = autoRefreshIntervalMs % 1000 === 0
    ? `${autoRefreshIntervalMs / 1000}s`
    : `${(autoRefreshIntervalMs / 1000).toFixed(1)}s`;
  const titleText = `gh-feed  ${data.repo.nameWithOwner}  #${data.pr.number}  ${data.pr.title}`;
  const prText = `PR: ${data.pr.url}`;
  const inferenceText = `Inference: ${data.prInference}`;
  const mouseCaptureStatus = !mouseCaptureEnabled
    ? "off"
    : composerMode
      ? "paused (compose)"
      : "on";
  const selectionText = `Open PRs: ${openPrCount} | mouse capture ${mouseCaptureStatus}`;
  const refreshStatusText = `Auto refresh: every ${refreshEvery} | last update ${fmtTimeOfDay(lastUpdatedAt)}${isRefreshing ? " | refreshing..." : ""}`;
  const refreshErrorText = refreshError ? `Last refresh failed: ${refreshError}` : "";
  const helpText = isRawModeSupported
    ? "Keys: j/k move, Enter compose, r reply, Tab focus, b PR list, m mouse capture, q quit"
    : "Non-interactive terminal detected: rendered once and exiting.";
  const topHeaderLines =
    countWrappedPlainLines(titleText, appWrapWidth) +
    countWrappedPlainLines(prText, appWrapWidth) +
    countWrappedPlainLines(inferenceText, appWrapWidth) +
    countWrappedPlainLines(selectionText, appWrapWidth) +
    countWrappedPlainLines(refreshStatusText, appWrapWidth) +
    (refreshError ? countWrappedPlainLines(refreshErrorText, appWrapWidth) : 0);
  const helpLineCount = countWrappedPlainLines(helpText, appWrapWidth);
  const panelRowsAvailable = Math.max(9, terminalRows - (topHeaderLines + helpLineCount + 4));
  const listPanelHeight = clamp(
    Math.floor(panelRowsAvailable * 0.35),
    5,
    Math.max(5, panelRowsAvailable - 6)
  );
  const detailPanelHeight = Math.max(6, panelRowsAvailable - listPanelHeight);
  const detailPanelInnerHeight = Math.max(1, detailPanelHeight - 2);
  const listContentBudget = Math.max(1, listPanelHeight - 3);
  const listWindow = clamp(listContentBudget, 1, Math.max(1, listRows.length));
  const listPageStep = Math.max(1, listWindow - 1);
  const listStart = clamp(
    safeActiveIndex - Math.floor(listWindow / 2),
    0,
    Math.max(0, listRows.length - listWindow)
  );

  type DetailActionId = "compose" | "reply" | "send" | "cancel";
  interface DetailActionButton {
    id: DetailActionId;
    label: string;
    color?: NonNullable<InlineSpan["color"]>;
    dim?: boolean;
  }
  interface DetailActionLayout extends DetailActionButton {
    startX: number;
    endX: number;
  }

  const detailActionButtons: DetailActionButton[] = useMemo(() => {
    if (composerMode) {
      return [
        {
          id: "send",
          label: isSubmittingComment ? "[Sending...]" : "[Send]",
          color: isSubmittingComment ? "gray" : "green",
          dim: isSubmittingComment
        },
        { id: "cancel", label: "[Cancel]", color: "yellow" }
      ];
    }

    if (selectedRow) {
      return [{ id: "reply", label: "[Reply]", color: "cyan" }];
    }

    return [{ id: "compose", label: "[Compose]", color: "cyan" }];
  }, [composerMode, isSubmittingComment, selectedRow]);

  const detailActionSpans = useMemo(() => {
    const spans: InlineSpan[] = [];
    detailActionButtons.forEach((button, idx) => {
      if (idx > 0) {
        spans.push({ text: " " });
      }

      spans.push({
        text: button.label,
        color: button.color,
        bold: true,
        dim: Boolean(button.dim)
      });
    });

    if (composerMode) {
      spans.push({ text: "  Ctrl+S send | Esc cancel", dim: true });
    } else if (selectedRow) {
      spans.push({ text: "  Press r to reply", dim: true });
    } else {
      spans.push({ text: "  Press Enter to add a new comment...", dim: true });
    }

    return spans;
  }, [composerMode, detailActionButtons, selectedRow]);

  const detailActionColumnStart = 4;
  const detailActionLayouts = useMemo<DetailActionLayout[]>(() => {
    let cursor = detailActionColumnStart;
    return detailActionButtons.map((button) => {
      const startX = cursor;
      const endX = cursor + button.label.length - 1;
      cursor = endX + 2;
      return {
        ...button,
        startX,
        endX
      };
    });
  }, [detailActionButtons]);

  const visibleRows = useMemo(() => {
    return listRows.slice(listStart, listStart + listWindow).map((row, idx) => {
      const absolute = listStart + idx;
      const selected = absolute === safeActiveIndex;
      if (row.kind === "add-comment") {
        return {
          row,
          selected,
          spans: [
            { text: selected ? "> " : "  ", color: selected ? "yellow" : "gray" },
            { text: row.label, color: "gray", dim: true }
          ] as InlineSpan[]
        };
      }

      const when = fmtRelativeOrAbsolute(row.createdAt);
      return {
        row,
        selected,
        spans: formatCommentListLine({
          selected,
          depth: row.depth,
          authorName: row.author,
          preview: row.subline,
          when,
          width: listWrapWidth
        })
      };
    });
  }, [listRows, listStart, listWindow, safeActiveIndex, listWrapWidth]);

  let layoutCursor = 0;
  layoutCursor += topHeaderLines;
  layoutCursor += 1; // list marginTop
  const listPanelTopRow = layoutCursor + 1;
  layoutCursor += listPanelHeight;
  const detailPanelTopRow = layoutCursor + 1;
  const listPanelBottomRow = listPanelTopRow + listPanelHeight - 1;
  const detailPanelBottomRow = detailPanelTopRow + detailPanelHeight - 1;
  const listFirstItemRow = listPanelTopRow + 2;
  const detailActionRow = detailPanelBottomRow - 1;

  const runDetailAction = useCallback((action: DetailActionId): void => {
    if (action === "compose") {
      openTopLevelComposer();
      return;
    }

    if (action === "reply") {
      startReplyForSelection();
      return;
    }

    if (action === "cancel") {
      closeComposer();
      return;
    }

    if (action === "send") {
      void submitComposerRef.current();
    }
  }, [closeComposer, openTopLevelComposer, startReplyForSelection]);

  let detailTitle = "";
  let detailLocation = "";
  let detailUrl = "";
  let detailBodyText = "";
  if (composerMode) {
    detailTitle =
      composerMode.mode === "top-level"
        ? "Write a top-level PR comment"
        : `Reply to ${composerMode.target.author}`;
    detailLocation =
      composerMode.mode === "top-level"
        ? "Target: PR discussion"
        : `Target: ${normalizeSingleLineLabel(composerMode.target.location)}`;
    detailUrl = "";
    const normalizedComposerBody = normalizeComposeNewlines(composerBody);
    detailBodyText = normalizedComposerBody.length > 0 ? `${normalizedComposerBody}|` : "|";
  } else if (selectedRow) {
    detailTitle = `${
      selectedRow.kind === "discussion"
        ? "Discussion"
        : selectedRow.kind === "inline"
          ? "Inline"
          : "Review"
    }  ${selectedRow.author}  ${fmtRelativeOrAbsolute(selectedRow.createdAt)}`;
    detailLocation = `Location: ${normalizeSingleLineLabel(selectedRow.location)}`;
    detailUrl = selectedRow.htmlUrl;
    detailBodyText = selectedRow.body;
  } else {
    detailTitle = "New top-level comment";
    detailLocation = "Select \"Press Enter to add a new comment...\" and press Enter to open the editor.";
    detailUrl = data.pr.url;
    detailBodyText = "Type your comment in the editor shown in this panel.";
  }
  const detailRenderOptions = composerMode ? undefined : { commitBaseUrl };
  const showPlaceholderBody = !composerMode && !selectedRow;
  const showPlainBody = showPlaceholderBody || Boolean(composerMode);
  // Detail panel interior contains:
  // 1) "Details" header row
  // 2) content block (title/location/url/error/body)
  // 3) action row
  // Reserve rows for header + action so body line budgeting matches visible space.
  const detailNonActionLines = Math.max(1, detailPanelInnerHeight - 2);
  let detailLinesAboveBody = 0;
  detailLinesAboveBody += countWrappedPlainLines(detailTitle, detailWrapWidth);
  detailLinesAboveBody += countWrappedPlainLines(detailLocation, detailWrapWidth);
  if (detailUrl) {
    detailLinesAboveBody += countWrappedPlainLines(detailUrl, detailWrapWidth);
  }
  if (composerError) {
    detailLinesAboveBody += countWrappedPlainLines(composerError, detailWrapWidth);
  }

  const detailBodyLines = Math.max(1, detailNonActionLines - detailLinesAboveBody);
  const detailPageStep = Math.max(1, detailBodyLines - 1);
  const detailLineCount = useMemo(() => {
    if (showPlainBody) {
      return countWrappedPlainLines(detailBodyText, detailWrapWidth);
    }

    return countWrappedMarkdownLines(detailBodyText, 0, detailWrapWidth, detailRenderOptions);
  }, [detailBodyText, detailRenderOptions, detailWrapWidth, showPlainBody]);
  const maxDetailOffset = Math.max(0, detailLineCount - detailBodyLines);
  const detailStartLine = composerMode ? maxDetailOffset : detailOffset;

  useEffect(() => {
    setDetailOffset((prev) => clamp(prev, 0, maxDetailOffset));
  }, [maxDetailOffset]);

  const moveIndex = useCallback((delta: number): void => {
    setActiveIndex((prev) => clamp(prev + delta, 0, maxIndex));
  }, [maxIndex]);

  const moveDetail = useCallback((delta: number): void => {
    setDetailOffset((prev) => clamp(prev + delta, 0, maxDetailOffset));
  }, [maxDetailOffset]);

  useEffect(() => {
    if (!isRawModeSupported || !stdin.isTTY || !stdout.isTTY || !mouseCaptureEnabled || Boolean(composerMode)) {
      return;
    }

    const enableMouse = "\u001B[?1000h\u001B[?1006h";
    const disableMouse = "\u001B[?1000l\u001B[?1006l";
    stdout.write(enableMouse);

    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const events = parseMouseSequences(text);
      if (events.length === 0) {
        return;
      }

      const panelAtMouseRow = (row: number): PanelFocus | null => {
        if (row >= detailPanelTopRow && row <= detailPanelBottomRow) {
          return "detail";
        }
        if (row >= listPanelTopRow && row <= listPanelBottomRow) {
          return "list";
        }
        return null;
      };

      for (const event of events) {
        const targetPanel = panelAtMouseRow(event.y) ?? panelFocusRef.current;

        if (event.code === 64 || event.code === 65) {
          const delta = event.code === 64 ? -1 : 1;
          panelFocusRef.current = targetPanel;
          setPanelFocus((prev) => (prev === targetPanel ? prev : targetPanel));
          if (targetPanel === "list") {
            moveIndex(delta);
          } else if (!composerMode) {
            moveDetail(delta);
          }
          continue;
        }

        if (event.kind === "M" && event.code === 0) {
          const clickedPanel = panelAtMouseRow(event.y);
          if (clickedPanel === "list") {
            panelFocusRef.current = "list";
            setPanelFocus("list");
            const offset = event.y - listFirstItemRow;
            if (offset >= 0 && offset < visibleRows.length) {
              const next = clamp(listStart + offset, 0, maxIndex);
              setActiveIndex(next);
            }
            continue;
          }

          if (clickedPanel === "detail") {
            panelFocusRef.current = "detail";
            setPanelFocus("detail");
            if (!composerMode && activeListRow.kind === "add-comment") {
              openTopLevelComposer();
              continue;
            }
            if (Math.abs(event.y - detailActionRow) <= 1) {
              const action = detailActionLayouts.find(
                (button) => event.x >= button.startX && event.x <= button.endX
              );
              if (action) {
                runDetailAction(action.id);
              }
            }
          }
        }
      }
    };

    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      stdout.write(disableMouse);
    };
  }, [
    composerMode,
    activeListRow.kind,
    detailActionLayouts,
    detailActionRow,
    detailPanelBottomRow,
    detailPanelTopRow,
    isRawModeSupported,
    listFirstItemRow,
    listPanelBottomRow,
    listPanelTopRow,
    listStart,
    maxIndex,
    mouseCaptureEnabled,
    moveDetail,
    moveIndex,
    openTopLevelComposer,
    runDetailAction,
    stdin,
    stdout,
    visibleRows.length
  ]);

  useInput(
    (input, key) => {
      const effectiveComposer = composerMode ?? pendingComposerRef.current;
      if (effectiveComposer) {
        const sanitizedInput = sanitizeComposeInput(input);

        if (key.ctrl && input === "c") {
          onExitRequest();
          return;
        }

        if (key.ctrl && input.toLowerCase() === "s") {
          void submitComposer();
          return;
        }

        if (key.escape) {
          closeComposer();
          return;
        }

        if (key.return) {
          if (!isSubmittingComment) {
            const textWithoutNewlines = sanitizedInput.replace(/\n/g, "");
            const newlineCount = Math.max(1, (sanitizedInput.match(/\n/g) || []).length);
            setComposerBody((prev) =>
              `${normalizeComposeNewlines(prev)}${textWithoutNewlines}${"\n".repeat(newlineCount)}`
            );
          }
          return;
        }

        if (sanitizedInput.includes("\n")) {
          if (!isSubmittingComment) {
            setComposerBody((prev) => `${normalizeComposeNewlines(prev)}${sanitizedInput}`);
          }
          return;
        }

        if (key.tab || input === "\t") {
          setPanelFocus((prev) => {
            const next = prev === "list" ? "detail" : "list";
            panelFocusRef.current = next;
            return next;
          });
          return;
        }

        if (key.backspace || input === "\u007f" || key.delete) {
          if (!isSubmittingComment) {
            setComposerBody((prev) => prev.slice(0, -1));
          }
          return;
        }

        if (!key.ctrl && !key.meta && input.length > 0 && !key.tab) {
          if (sanitizedInput.length === 0) {
            return;
          }

          if (!isSubmittingComment) {
            setComposerBody((prev) => `${normalizeComposeNewlines(prev)}${sanitizedInput}`);
          }
          return;
        }

        return;
      }

      if (input === "q" || key.escape || (key.ctrl && input === "c")) {
        onExitRequest();
        return;
      }

      if (input === "b") {
        onBackToPrSelection();
        return;
      }

      if (input === "m") {
        setMouseCaptureEnabled((prev) => !prev);
        return;
      }

      if (input === "r" && selectedRow) {
        startReplyForSelection();
        return;
      }

      if (key.return && activeListRow.kind === "add-comment") {
        openTopLevelComposer();
        return;
      }

      if (key.tab || input === "\t") {
        if (panelFocus === "list" && activeListRow.kind === "add-comment") {
          openTopLevelComposer();
          return;
        }

        setPanelFocus((prev) => {
          const next = prev === "list" ? "detail" : "list";
          panelFocusRef.current = next;
          return next;
        });
        return;
      }

      if (input === "g") {
        if (panelFocus === "list") {
          setActiveIndex(0);
        } else {
          setDetailOffset(0);
        }
        return;
      }

      if (input === "G") {
        if (panelFocus === "list") {
          setActiveIndex(maxIndex);
        } else {
          setDetailOffset(maxDetailOffset);
        }
        return;
      }

      if ((key as { pageDown?: boolean }).pageDown) {
        if (panelFocus === "list") {
          moveIndex(listPageStep);
        } else {
          moveDetail(detailPageStep);
        }
        return;
      }

      if ((key as { pageUp?: boolean }).pageUp) {
        if (panelFocus === "list") {
          moveIndex(-listPageStep);
        } else {
          moveDetail(-detailPageStep);
        }
        return;
      }

      if (key.downArrow || input === "j") {
        if (panelFocus === "list") {
          moveIndex(1);
        } else {
          moveDetail(1);
        }
        return;
      }

      if (key.upArrow || input === "k") {
        if (panelFocus === "list") {
          moveIndex(-1);
        } else {
          moveDetail(-1);
        }
      }
    },
    { isActive: Boolean(isRawModeSupported) }
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="green" wrap="wrap">
        {titleText}
      </Text>
      <Text dimColor wrap="wrap">
        {prText}
      </Text>
      <Text dimColor wrap="wrap">
        {inferenceText}
      </Text>
      <Text dimColor wrap="wrap">
        {selectionText}
      </Text>
      <Text dimColor={!refreshError} color={refreshError ? "yellow" : undefined} wrap="wrap">
        {refreshStatusText}
      </Text>
      {refreshError && (
        <Text color="red" wrap="wrap">
          {refreshErrorText}
        </Text>
      )}

      <Box marginTop={1} flexDirection="column" borderStyle="round" paddingX={1} height={listPanelHeight}>
        <Text color={panelFocus === "list" ? "yellow" : "cyan"} wrap="wrap">
          {`Comments (${rows.length})${panelFocus === "list" ? "  [focus]" : ""}`}
        </Text>
        {visibleRows.map((item) => (
          <Text key={`comment-row-${item.row.key}`} wrap="truncate-end">
            {""}
            <InlineText spans={item.spans} />
          </Text>
        ))}
      </Box>

      <Box flexDirection="column" borderStyle="round" paddingX={1} height={detailPanelHeight}>
        <Text color={panelFocus === "detail" ? "yellow" : "magenta"} wrap="wrap">
          {`Details${panelFocus === "detail" ? "  [focus]" : ""}`}
        </Text>
        <Box flexDirection="column">
          <Text wrap="wrap">
            {detailTitle}
          </Text>
          <Text dimColor wrap="wrap">
            {detailLocation}
          </Text>
          {detailUrl && (
            <Text dimColor wrap="wrap">
              {detailUrl}
            </Text>
          )}
          {composerError && (
            <Text color="red" wrap="wrap">
              {composerError}
            </Text>
          )}
          {showPlainBody ? (
            <PlainBody
              text={detailBodyText}
              startLine={detailStartLine}
              maxLines={detailBodyLines}
              wrapWidth={detailWrapWidth}
              dim={showPlaceholderBody}
              leftPad={1}
            />
          ) : (
            <Body
              text={detailBodyText}
              startLine={detailStartLine}
              maxLines={detailBodyLines}
              wrapWidth={detailWrapWidth}
              renderOptions={detailRenderOptions}
            />
          )}
        </Box>
        <Text wrap="truncate-end">
          {""}
          <InlineText spans={detailActionSpans} />
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor wrap="wrap">
          {composerMode
            ? "Compose mode: type text, Enter newline, Ctrl+S send, Esc cancel."
            : helpText}
        </Text>
      </Box>
    </Box>
  );
}
