import type { ContextObject, ContextItem, ContentBlock } from "./types.js";
import { makeStatusLine, type StatusSummary } from "./status.js";

const ASSISTANT_LABEL_PREFIX_RE = /^(?:\s*\[assistant message \d+\.\d+\]\s*)+/;

function findFirstTextBlock(content: ContentBlock[]): { type: "text"; text: string } | null {
  for (const block of content) {
    if (block.type === "text") return block;
  }
  return null;
}

function prefixFirstTextBlockOrPrepend(
  content: ContentBlock[],
  prefix: string
): ContentBlock[] {
  const block = findFirstTextBlock(content);
  if (block) {
    block.text = prefixText(block.text, prefix);
    return content;
  }

  return [{ type: "text", text: prefix }, ...content];
}

function prefixText(text: string, prefix: string): string {
  return text ? `${prefix} ${text}` : prefix;
}

function stripAssistantLabelPrefix(text: string): string {
  return text.replace(ASSISTANT_LABEL_PREFIX_RE, "");
}

function findLastTextBlock(content: ContentBlock[]): { type: "text"; text: string } | null {
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i].type === "text") return content[i] as { type: "text"; text: string };
  }
  return null;
}

export function injectIds(ctx: ContextObject): void {
  for (const item of ctx.items) {
    if (item.kind === "user-message") {
      const block = findFirstTextBlock(item.content);
      if (block) {
        block.text = prefixText(block.text, `[${item.id}]`);
      }
    } else if (item.kind === "assistant-message") {
      const block = findFirstTextBlock(item.content);
      if (block) {
        block.text = prefixText(
          stripAssistantLabelPrefix(block.text),
          `[${item.id}]`
        );
      }
    } else if (item.kind === "tool-call") {
      continue;
    } else if (item.kind === "tool-result") {
      if (ctx.format === "anthropic-messages") {
        if (typeof item.output === "string") {
          item.output = prefixText(item.output, `[${item.id}]`);
        } else {
          item.output = prefixFirstTextBlockOrPrepend(
            item.output,
            `[${item.id}]`
          );
        }
      } else {
        // Inject ID at the start of tool result output
        if (typeof item.output === "string") {
          item.output = prefixText(item.output, `[${item.id}]`);
        } else {
          const block = findFirstTextBlock(item.output);
          if (block) {
            block.text = prefixText(block.text, `[${item.id}]`);
          }
        }
      }
    }
  }
}

export function injectStatusLine(
  ctx: ContextObject,
  statusSummary: StatusSummary
): void {
  // Find the last user message
  let lastUserMessage: ContextItem | null = null;
  for (let i = ctx.items.length - 1; i >= 0; i--) {
    if (ctx.items[i].kind === "user-message") {
      lastUserMessage = ctx.items[i];
      break;
    }
  }

  if (!lastUserMessage || lastUserMessage.kind !== "user-message") return;
  const statusLine = `\n\n${makeStatusLine(statusSummary)}`;

  const block = findLastTextBlock(lastUserMessage.content);
  if (block) {
    block.text += statusLine;
  } else if (ctx.format !== "anthropic-messages") {
    lastUserMessage.content.push({ type: "text", text: statusLine });
  }
}

export function prependTextToFirstUserMessage(
  ctx: ContextObject,
  text: string
): void {
  if (!text.trim()) return;

  let firstUserMessage: ContextItem | null = null;
  for (let i = 0; i < ctx.items.length; i++) {
    if (ctx.items[i].kind === "user-message") {
      firstUserMessage = ctx.items[i];
      break;
    }
  }

  if (!firstUserMessage || firstUserMessage.kind !== "user-message") return;

  const block = findFirstTextBlock(firstUserMessage.content);
  if (block) {
    block.text = `${text}\n\n${block.text}`;
    return;
  }

  firstUserMessage.content.unshift({ type: "text", text });
}
