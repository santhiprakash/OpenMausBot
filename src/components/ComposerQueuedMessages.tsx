import { CornerDownRight, Trash2 } from "lucide-react";

export function composerCanSteerQueuedMessages(
  busy: boolean,
  locked: boolean,
  pendingCount: number,
  approvalPending = false,
): boolean {
  return busy && !locked && !approvalPending && pendingCount > 0;
}

/** Messages held by the harness until the running turn settles.
 *
 * The queue sits directly above the composer rather than pretending these
 * words are already part of the transcript. Only its head owns Steer: room
 * queues drain one item at a time, while bot queues coalesce all waiting
 * items into one follow-up. Delete remains available on every exact queue id.
 */
export function QueuedComposerMessages({
  items,
  onSteer,
  steerMode = "all",
  steering = false,
  onCancel,
}: {
  items: Array<{ queueId: string; text: string }>;
  onSteer?: () => void;
  steerMode?: "all" | "next";
  steering?: boolean;
  onCancel: (queueId: string) => void;
}) {
  if (!items.length) return null;

  const multiple = items.length > 1;
  const steerLabel = steering
    ? "Steering…"
    : multiple
      ? steerMode === "all"
        ? "Steer all"
        : "Steer next"
      : "Steer";
  const steerDescription = multiple
    ? steerMode === "all"
      ? `Steer all ${items.length} queued messages now`
      : "Steer the next queued message now"
    : "Steer queued message now";

  return (
    <div
      className="relative z-[1] mx-3 -mb-3 max-h-36 overflow-y-auto rounded-t-2xl border border-b-0 border-hairline/40 bg-raised/95 pb-3 shadow-sm backdrop-blur-sm"
      aria-label={`${items.length} queued ${items.length === 1 ? "message" : "messages"}`}
      aria-live="polite"
    >
      <ul className="divide-y divide-hairline/25" aria-label="Queued messages">
        {items.map((item, index) => (
          <li key={item.queueId} className="flex min-h-10 min-w-0 items-center gap-2 px-2.5 py-1.5">
            <CornerDownRight
              size={14}
              strokeWidth={1.8}
              className="shrink-0 text-ink-secondary"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-[14px] text-ink" title={item.text}>
              {item.text}
            </span>
            {index === 0 && onSteer && (
              <button
                type="button"
                onClick={onSteer}
                disabled={steering}
                aria-label={steering ? "Steering queued messages" : steerDescription}
                title={steerDescription}
                className="flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[13px] font-medium text-ink-secondary outline-none hover:bg-raised-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-wait disabled:opacity-60"
              >
                <CornerDownRight
                  size={13}
                  strokeWidth={2}
                  className={steering ? "animate-pulse" : undefined}
                  aria-hidden="true"
                />
                {steerLabel}
              </button>
            )}
            <button
              type="button"
              onClick={() => onCancel(item.queueId)}
              aria-label={`Delete queued message ${index + 1} of ${items.length}`}
              title="Delete this queued message"
              className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-secondary outline-none hover:bg-raised-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
