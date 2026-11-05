// Parse Slack mrkdwn text into rich_text block elements.
// Supports: *bold*, _italic_, ~strike~, `code`, and combinations, plus the
// <@U…>, <!subteam^S…>, <#C…>, <!here|channel|everyone> and <url|label> tokens.

interface RichTextStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
}

type RichTextElement = (
  | { type: 'text'; text: string }
  | { type: 'user'; user_id: string }
  | { type: 'usergroup'; usergroup_id: string }
  | { type: 'channel'; channel_id: string }
  | { type: 'broadcast'; range: 'here' | 'channel' | 'everyone' }
  | { type: 'link'; url: string; text?: string }
  | { type: 'emoji'; name: string }
) & { style?: RichTextStyle };

interface RichTextSection {
  type: 'rich_text_section';
  elements: RichTextElement[];
}

interface RichTextList {
  type: 'rich_text_list';
  style: 'bullet' | 'ordered';
  indent: number;
  /** Items already numbered at this level, so "2." after a nested list stays "2.". */
  offset?: number;
  elements: RichTextSection[];
}

interface RichTextPreformatted {
  type: 'rich_text_preformatted';
  elements: Array<{ type: 'text'; text: string }>;
}

type RichTextBlockElement = RichTextSection | RichTextList | RichTextPreformatted;

interface RichTextBlock {
  type: 'rich_text';
  elements: RichTextBlockElement[];
}

// Markers and their corresponding style keys
const MARKERS: [string, keyof RichTextStyle][] = [
  ['`', 'code'],
  ['*', 'bold'],
  ['_', 'italic'],
  ['~', 'strike'],
];

// Combining marks count as word characters so a decomposed "é" (e + U+0301)
// behaves the same as its precomposed form.
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

function isWordCodePoint(cp: number | undefined): boolean {
  return cp !== undefined && WORD_CHAR.test(String.fromCodePoint(cp));
}

// Both helpers work on whole code points; indexing by UTF-16 unit would hand a
// lone surrogate to the regex and misclassify every astral letter.
function wordCharBefore(text: string, i: number): boolean {
  if (i <= 0) return false;
  const prev = text.charCodeAt(i - 1);
  const isTrailSurrogate = prev >= 0xdc00 && prev <= 0xdfff;
  return isWordCodePoint(text.codePointAt(isTrailSurrogate && i >= 2 ? i - 2 : i - 1));
}

function wordCharAfter(text: string, i: number): boolean {
  return isWordCodePoint(text.codePointAt(i + 1));
}

interface SpanBounds {
  inner: string;
  nextIndex: number;
}

interface InlineOptions {
  /** Turn bare http(s) URLs into link elements (send path; drafts keep them as text). */
  linkUrls?: boolean;
}

interface MarkerMatch {
  elements: RichTextElement[];
  nextIndex: number;
}

// Locate the span opening at `i`: its inner text and the index to continue the walk
// from, or null when no span starts there. The guard order is load-bearing: each
// guard assumes the previous ones already rejected, so reordering them changes what
// parses.
function findSpan(text: string, marker: string, i: number): SpanBounds | null {
  if (text[i] !== marker) return null;

  // Only "_" requires word boundaries; Slack applies *bold*, ~strike~ and `code`
  // mid-word. Without this, the underscore in one URL or identifier pairs with the
  // underscore in a completely unrelated one later in the message, and everything
  // between the two gets consumed as italic.
  const needsBoundary = marker === '_';
  if (needsBoundary && wordCharBefore(text, i)) return null;

  const end = text.indexOf(marker, i + 1);
  if (end === -1) return null;
  // A mid-word "_" (the one in "file_name") does not close a span. Leave the text
  // literal rather than searching on for a later candidate, which would swallow
  // everything in between.
  if (needsBoundary && wordCharAfter(text, end)) return null;

  const inner = text.substring(i + 1, end);
  // Don't match empty content or content that starts/ends with space
  if (inner.length === 0 || inner.startsWith(' ') || inner.endsWith(' ')) return null;

  return { inner, nextIndex: end + 1 };
}

// Build the elements for one span's inner text, applying `styleKey` on top of any
// styles the inner text carries itself.
function styleSpan(inner: string, styleKey: keyof RichTextStyle, opts: InlineOptions): RichTextElement[] {
  // Code spans don't nest
  if (styleKey === 'code') {
    const style: RichTextStyle = { [styleKey]: true };
    return [{ type: 'text', text: inner, style }];
  }

  // Recursively parse inner content for nested formatting, keeping each element's type
  return parseInline(inner, opts).map(el => ({
    ...el,
    style: { ...el.style, [styleKey]: true },
  }));
}

// Try every marker at position `i`, returning the span's elements and the index to
// continue the walk from, or null when no marker applies there.
function tryMatchMarker(text: string, i: number, opts: InlineOptions): MarkerMatch | null {
  // ```x``` on one line is inline code too, as Slack renders it.
  if (text.startsWith('```', i)) {
    const end = text.indexOf('```', i + 3);
    const inner = end === -1 ? '' : text.substring(i + 3, end);
    if (inner && !inner.includes('\n')) {
      return { elements: [{ type: 'text', text: inner, style: { code: true } }], nextIndex: end + 3 };
    }
  }
  for (const [marker, styleKey] of MARKERS) {
    const span = findSpan(text, marker, i);
    if (!span) continue;

    return { elements: styleSpan(span.inner, styleKey, opts), nextIndex: span.nextIndex };
  }

  return null;
}

// Plain character: append to last plain element or create new one
function appendPlainChar(elements: RichTextElement[], char: string): void {
  const last = elements.at(-1);
  if (last?.type === 'text' && !last.style) {
    last.text += char;
  } else {
    elements.push({ type: 'text', text: char });
  }
}

// Defensive cleanup: no current path produces an empty `style` object (plain
// characters carry no `style` key, and every styled span sets at least one), but
// the pre-refactor parser ran this pass and it is kept so a future marker that
// yields an empty style cannot leak `style: {}` into the rich_text payload.
function stripEmptyStyles(elements: RichTextElement[]): RichTextElement[] {
  return elements.map(el => {
    if (el.style && Object.keys(el.style).length === 0) {
      const { style, ...rest } = el;
      return rest as RichTextElement;
    }
    return el;
  });
}

// Angle-bracket tokens, matched on the body between "<" and ">". The optional
// "|label" is dropped for mentions and channels, and kept as text for links.
const TOKEN_LABEL = String.raw`(?:\|[^>]*)?`;
const USER_TOKEN = new RegExp(`^@([UW][A-Z0-9]+)${TOKEN_LABEL}$`);
const USERGROUP_TOKEN = new RegExp(String.raw`^!subteam\^([A-Z0-9]+)${TOKEN_LABEL}$`);
const CHANNEL_TOKEN = new RegExp(`^#([CG][A-Z0-9]+)${TOKEN_LABEL}$`);
const BROADCAST_TOKEN = new RegExp(`^!(here|channel|everyone)${TOKEN_LABEL}$`);
const LINK_TOKEN = /^((?:https?:\/\/|mailto:)[^|\s>]+)(?:\|([^>]*))?$/;

function tokenElement(body: string): RichTextElement | null {
  const user = USER_TOKEN.exec(body);
  if (user) return { type: 'user', user_id: user[1] };

  const usergroup = USERGROUP_TOKEN.exec(body);
  if (usergroup) return { type: 'usergroup', usergroup_id: usergroup[1] };

  const channel = CHANNEL_TOKEN.exec(body);
  if (channel) return { type: 'channel', channel_id: channel[1] };

  const broadcast = BROADCAST_TOKEN.exec(body);
  if (broadcast) return { type: 'broadcast', range: broadcast[1] as 'here' | 'channel' | 'everyone' };

  const link = LINK_TOKEN.exec(body);
  if (!link) return null;
  return link[2] ? { type: 'link', url: link[1], text: link[2] } : { type: 'link', url: link[1] };
}

// Try to read a "<…>" token at `i`. Unknown forms return null and stay literal text.
function tryMatchToken(text: string, i: number): MarkerMatch | null {
  if (text[i] !== '<') return null;

  const end = text.indexOf('>', i + 1);
  if (end === -1) return null;

  const element = tokenElement(text.substring(i + 1, end));
  return element ? { elements: [element], nextIndex: end + 1 } : null;
}

// An emoji shortcode such as ":pray:" or ":+1:". Plain-text messages get these
// from Slack's own mrkdwn rendering; rich_text needs an explicit emoji element or
// the shortcode shows literally. The name needs a letter or starts with + or -
// (":+1:", ":-1:"), and the opening colon must not follow a letter or digit, so
// "10:30" and "a:b:c" stay text.
const EMOJI = /^:([a-z0-9_+'-]*[a-z][a-z0-9_+'-]*|[+-][a-z0-9_+'-]+):/;

function tryMatchEmoji(text: string, i: number): MarkerMatch | null {
  if (text[i] !== ':') return null;
  if (i > 0 && /[A-Za-z0-9]/.test(text[i - 1])) return null;
  const match = EMOJI.exec(text.slice(i, i + 102));
  return match ? { elements: [{ type: 'emoji', name: match[1] }], nextIndex: i + match[0].length } : null;
}

// A Markdown link, [label](url). Slack mrkdwn has no such syntax (it shows the
// brackets literally), so it becomes a link element with the label, the same as
// Slack's own <url|label>.
const MD_LINK = /^\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/;

function tryMatchMarkdownLink(text: string, i: number): MarkerMatch | null {
  if (text[i] !== '[') return null;
  const match = MD_LINK.exec(text.slice(i));
  return match ? { elements: [{ type: 'link', url: match[2], text: match[1] }], nextIndex: i + match[0].length } : null;
}

/**
 * Rewrite Markdown links to Slack's <url|label> in plain message text, outside
 * code. For the text Slack renders itself (send, edit, schedule) and the
 * notification fallback; the rich_text path makes link elements instead.
 */
export function markdownLinksToSlack(text: string): string {
  return text
    .split(/(```[\s\S]*?```|```[\s\S]*$|`[^`\n]*`)/)
    .map((part, index) => (index % 2 === 1
      ? part
      : part.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (_whole, label: string, url: string) => `<${url}|${label.replace(/[<>|]/g, '')}>`)))
    .join('');
}

// A bare http(s) URL. Plain-text messages get these linked by Slack's own
// mrkdwn rendering; rich_text needs a link element or the URL is not clickable.
// Trailing sentence punctuation stays out, and so does a ")" with no "(" in the URL.
const BARE_URL = /^https?:\/\/[^\s<>]+/;

function tryMatchUrl(text: string, i: number): MarkerMatch | null {
  if (text[i] !== 'h' || (i > 0 && /[A-Za-z0-9]/.test(text[i - 1]))) return null;
  const match = BARE_URL.exec(text.slice(i));
  if (!match) return null;
  let url = match[0].replace(/[.,;:!?'"*_~]+$/, '');
  while (url.endsWith(')') && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length) {
    url = url.slice(0, -1).replace(/[.,;:!?'"*_~]+$/, '');
  }
  if (!/^https?:\/\/[^/]/.test(url)) return null;
  return { elements: [{ type: 'link', url }], nextIndex: i + url.length };
}

function parseInline(text: string, opts: InlineOptions = {}): RichTextElement[] {
  const elements: RichTextElement[] = [];

  let i = 0;
  while (i < text.length) {
    // Tokens go first so a marker character inside a URL never opens a span
    const match = tryMatchToken(text, i)
      ?? tryMatchMarkdownLink(text, i)
      ?? (opts.linkUrls ? tryMatchUrl(text, i) : null)
      ?? tryMatchEmoji(text, i)
      ?? tryMatchMarker(text, i, opts);
    if (match) {
      elements.push(...match.elements);
      i = match.nextIndex;
    } else {
      appendPlainChar(elements, text[i]);
      i++;
    }
  }

  return stripEmptyStyles(elements);
}

// A list item line: optional indentation, then "•" or "-" (bullet) or
// "1." / "1)" (ordered), then at least one space. Two spaces or one tab of
// indentation is one nesting level. "* " is not a bullet: it is too often a bold
// span that lost its closing star.
const LIST_LINE = /^([ \t]*)(?:([•\-])|(\d+)[.)])[ \t]+(.*)$/;

interface ListLine {
  style: 'bullet' | 'ordered';
  indent: number;
  /** The number typed on an ordered line ("3." gives 3), 0 for a bullet. */
  number: number;
  text: string;
}

function listLine(line: string): ListLine | null {
  const match = LIST_LINE.exec(line);
  if (!match) return null;
  const width = match[1].replace(/\t/g, '  ').length;
  return {
    style: match[2] ? 'bullet' : 'ordered',
    indent: Math.min(Math.floor(width / 2), 8),
    number: match[3] ? Number.parseInt(match[3], 10) : 0,
    text: match[4],
  };
}

function section(text: string, opts: InlineOptions = {}): RichTextSection {
  const elements = parseInline(text, opts);
  return { type: 'rich_text_section', elements: elements.length > 0 ? elements : [{ type: 'text', text: '' }] };
}

// One logical piece of a message that has lists: a prose line, a list item, or
// a whole fenced code block.
type Segment =
  | { kind: 'prose'; text: string }
  | { kind: 'item'; item: ListLine; raw: string }
  | { kind: 'code'; text: string };

const FENCE = '```';

// Split the text into segments. A line with an odd number of ``` opens or
// closes a fence there: text before the fence stays on its side (prose before an
// opening fence, code before a closing one). A line with an even number is
// inline code and is classified normally, so "- use ```x``` here" is an item.
function segment(text: string): Segment[] {
  const segments: Segment[] = [];
  let code: string[] | null = null;
  for (const line of text.split('\n')) {
    const fences = line.split(FENCE).length - 1;
    if (code === null) {
      if (fences % 2 === 0) {
        const item = listLine(line);
        segments.push(item ? { kind: 'item', item, raw: line } : { kind: 'prose', text: line });
        continue;
      }
      const at = line.lastIndexOf(FENCE);
      const before = line.slice(0, at).trimEnd();
      if (before) segments.push({ kind: 'prose', text: before });
      const after = line.slice(at + FENCE.length);
      code = after ? [after] : [];
    } else {
      if (fences % 2 === 0) {
        code.push(line);
        continue;
      }
      const at = line.indexOf(FENCE);
      if (at > 0) code.push(line.slice(0, at));
      segments.push({ kind: 'code', text: code.join('\n') });
      code = null;
      const after = line.slice(at + FENCE.length).trim();
      if (after) segments.push({ kind: 'prose', text: after });
    }
  }
  // An unclosed fence stays code to the end, as Slack renders it.
  if (code !== null) segments.push({ kind: 'code', text: code.join('\n') });
  return segments;
}

/**
 * Numbered items that continue a count across prose ("1. a", a paragraph, "2. b").
 * Slack's composer cannot continue a numbered list across a text section: the
 * second list shows "1." again, whatever its offset says. Such a run of items is
 * kept as the literal text typed ("2. b"), which always shows the right number.
 * Only items that keep counting are affected: a "1." after prose still starts a new
 * list, and items that follow each other directly stay one real list.
 */
function keepInterruptedNumberingAsText(segments: Segment[]): Segment[] {
  const demote = new Set<number>();
  // The consecutive ordered items at one indent, each run ended by prose or another kind of item.
  let run: number[] = [];
  let chain: number[] = [];
  let sawProse = false;
  const closeRun = () => {
    if (run.length > 0) chain = chain.concat(run);
    run = [];
  };
  const closeChain = () => {
    closeRun();
    chain = [];
  };
  for (let index = 0; index < segments.length; index++) {
    const part = segments[index];
    if (part.kind === 'prose') {
      if (run.length > 0) closeRun();
      sawProse = true;
      continue;
    }
    if (part.kind === 'code') {
      closeChain();
      sawProse = false;
      continue;
    }
    const { item } = part;
    const last = chain.length > 0 ? chain[chain.length - 1] : run.length > 0 ? run[run.length - 1] : -1;
    const previous = last >= 0 ? (segments[last] as { kind: 'item'; item: ListLine }).item : undefined;
    const sameLevel = item.style === 'ordered' && previous && previous.style === 'ordered' && previous.indent === item.indent;
    if (!sameLevel) {
      closeChain();
      sawProse = false;
      if (item.style === 'ordered') run = [index];
      continue;
    }
    if (sawProse && run.length === 0) {
      // A new run after prose: it continues the count when it does not start again at 1.
      if (item.number > 1) {
        for (const member of chain) demote.add(member);
        demote.add(index);
        run = [index];
      } else {
        chain = [];
        run = [index];
      }
    } else {
      run.push(index);
      if (chain.some((member) => demote.has(member))) demote.add(index);
    }
    sawProse = false;
  }
  return segments.map((part, index) => (demote.has(index) && part.kind === 'item' ? { kind: 'prose', text: part.raw } : part));
}

export function parseMrkdwn(input: string, opts: InlineOptions = {}): RichTextBlock[] {
  // A --message-file saved with Windows line endings must parse the same.
  const text = input.replace(/\r\n?/g, '\n');
  // Keep newlines embedded in text elements rather than splitting into multiple sections.
  // Slack's draft composer renders multiple rich_text_section elements inline (no line breaks),
  // but correctly preserves \n characters within a single text element.
  // Lines that start with "• ", "- " or "1. " become rich_text_list blocks, the
  // structure Slack's own composer writes for a list, so they render as a real list
  // (hanging indent, numbering) instead of literal bullet characters.
  const segments = keepInterruptedNumberingAsText(segment(text));
  // Only lists and fenced blocks need more than one section.
  if (!segments.some((part) => part.kind === 'item' || part.kind === 'code')) {
    return [{ type: 'rich_text', elements: [section(text, opts)] }];
  }

  const elements: RichTextBlockElement[] = [];
  // Per indent level, in the current run of list lines: how many ordered items
  // are shown, and the style of the last list. Prose or code ends the run.
  const numbered = new Map<number, number>();
  const styles = new Map<number, 'bullet' | 'ordered'>();
  let prose: string[] = [];
  const endRun = () => {
    numbered.clear();
    styles.clear();
  };
  const flushProse = () => {
    if (prose.length === 0) return;
    // The line break before a list belongs to the list, as in Slack's composer.
    const body = prose.join('\n').replace(/\n$/, '');
    if (body.length > 0 || elements.length === 0) elements.push(section(body, opts));
    prose = [];
    endRun();
  };

  for (const part of segments) {
    if (part.kind === 'prose') {
      // A blank line right after a list is kept: it becomes a leading "\n" in the
      // next section, which is how Slack's composer stores the gap after a list.
      prose.push(part.text);
      continue;
    }
    flushProse();
    if (part.kind === 'code') {
      elements.push({ type: 'rich_text_preformatted', elements: [{ type: 'text', text: part.text }] });
      endRun();
      continue;
    }

    const item = part.item;
    // Going back up a level restarts every deeper level.
    for (const level of [...numbered.keys()]) if (level > item.indent) numbered.delete(level);
    for (const level of [...styles.keys()]) if (level > item.indent) styles.delete(level);

    const last = elements.at(-1);
    if (last?.type === 'rich_text_list' && last.style === item.style && last.indent === item.indent) {
      last.elements.push(section(item.text, opts));
    } else {
      // Slack's message view draws a list that comes back up from a nested list
      // in the style of the earlier list at that level ("1." under a bullet list
      // shows as a bullet). An empty section in between ends that run; it takes
      // no space on screen.
      const earlier = styles.get(item.indent);
      if (earlier && earlier !== item.style && last?.type === 'rich_text_list' && last.indent > item.indent) {
        elements.push({ type: 'rich_text_section', elements: [] });
      }
      const list: RichTextList = { type: 'rich_text_list', style: item.style, indent: item.indent, elements: [section(item.text, opts)] };
      // Continue from the items already shown at this level, or from the number
      // typed when it is higher ("2." after a bullet at the same level, as in
      // Markdown). "1." on every line still counts up through the counter.
      const before = item.style === 'ordered'
        ? Math.max(numbered.get(item.indent) ?? 0, Math.min(item.number, 10_000) - 1)
        : 0;
      if (before > 0) list.offset = before;
      elements.push(list);
    }

    styles.set(item.indent, item.style);
    if (item.style === 'ordered') {
      // The number this item is shown with: the list's offset plus its position.
      const current = elements.at(-1) as RichTextList;
      numbered.set(item.indent, (current.offset ?? 0) + current.elements.length);
    } else {
      numbered.delete(item.indent);
    }
  }
  flushProse();

  return [{ type: 'rich_text', elements }];
}

/**
 * The rich_text blocks for a message whose text has list lines, or undefined
 * when it has none. Send, edit and schedule post plain text, which Slack renders
 * without lists; they pass these blocks only when there is a list to show, so
 * every other message keeps Slack's own text rendering exactly as before.
 */
export function listBlocksFor(text: string): RichTextBlock[] | undefined {
  // Sent with blocks, the text loses Slack's own linking of bare URLs, so link them here.
  const blocks = parseMrkdwn(text, { linkUrls: true });
  return blocks[0].elements.some((element) => element.type === 'rich_text_list') ? blocks : undefined;
}
