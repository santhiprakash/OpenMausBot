import type { Message } from "@/state/store";

export function replySnippet(text: string, limit = 160): string {
  const clean = text
    .replace(
      /<attached-(image|file)\s+path="[^"]*"(?:\s+name="[^"]*")?\s*\/>/g,
      (_tag, kind: "image" | "file") => kind === "image" ? "[image]" : "[file]",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
export function replyAuthor(message: Message, fallback = "Assistant"): string {
  return message.role === "user" ? "You" : (message.from?.name ?? fallback);
}
