// The profile row at the very bottom of the sidebar, and the menu it opens.
//
// Everything app-level used to sit in that row as unlabelled icons crowding
// the name: a phone, an update arrow, a gear. Three icons is a guessing game
// and there was nowhere to put a fourth. They are now a menu that the row
// opens on click — the shape every desktop app uses for "this is about the
// app, not about what you are looking at".
//
// The update entry is the one item that reports progress in place, so it
// keeps the menu open and re-labels itself as it works.
import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  Check,
  Info,
  HelpCircle,
  Loader2,
  RefreshCw,
  Settings as SettingsIcon,
  Smartphone,
} from "lucide-react";

import { InitialsAvatar } from "./Avatar";
import { DiscordIcon } from "./DiscordIcon";
import { AboutDialog } from "./AboutDialog";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";
import { phoneSettingsAction, useSidebarPhoneStatus } from "./SidebarPhoneButton";
import { useStore } from "@/state/store";
import { useUpdaterState, type UpdaterState } from "@/lib/updater";
import { cn } from "@/lib/cn";
import { FEEDBACK_URL, HELP_CENTER_URL, openExternalLink } from "@/lib/app-links";

/** "Milind Soni" → "MS", "milind" → "M", "you@x.dev" → "Y", unset → "?" */
export function profileInitials(profile?: { name?: string; email?: string }): string {
  const name = profile?.name?.trim();
  if (name) {
    const words = name.split(/\s+/);
    return words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  }
  const email = profile?.email?.trim();
  return email ? email[0]!.toUpperCase() : "?";
}

/** The name shown on the row: the profile name, else the email, else "You". */
export function profileLabel(profile?: { name?: string; email?: string }): string {
  return profile?.name?.trim() || profile?.email?.trim() || "You";
}

export type UpdatePhase =
  | UpdaterState["status"]
  /** a check came back with nothing — acknowledged for three seconds so the
   * click is never silent */
  | "up-to-date";

/** One state machine for the update entry, kept pure so the label/verb pairs
 * can be tested without a bridge. `upToDate` is the 3s acknowledgement after
 * a check that found nothing — otherwise a check is silent. */
export function updatePhase(state: UpdaterState | null, upToDate: boolean): UpdatePhase {
  const status = state?.status ?? "idle";
  if (status !== "idle") return status;
  return upToDate ? "up-to-date" : "idle";
}

export function updateLabel(phase: UpdatePhase, state: UpdaterState | null): string {
  switch (phase) {
    case "available":
      return `Version ${state?.version ?? ""} available — download`.replace("  ", " ");
    case "downloading":
      return state?.percent == null ? "Starting download…" : `Downloading… ${Math.round(state.percent)}%`;
    case "downloaded":
      return `Version ${state?.version ?? ""} ready — restart`.replace("  ", " ");
    case "installing":
      return "Restarting to update…";
    case "checking":
      return "Checking for updates…";
    case "handed-off":
      return "Finish the update in your terminal";
    case "error":
      return state?.message?.trim() || "Update failed — try again";
    case "up-to-date":
      return "You're up to date";
    default:
      return "Check for updates";
  }
}

/** A phase that is mid-flight takes no further clicks. `pending` covers the
 * gap between the click and the bridge reporting the state it started: both
 * download and install round-trip through main first, and without this the
 * row would sit there looking clickable. */
export function updateBusy(phase: UpdatePhase, pending = false): boolean {
  return pending || phase === "checking" || phase === "downloading" || phase === "installing";
}

function UpdateIcon({ phase, pending, size = 18 }: { phase: UpdatePhase; pending: boolean; size?: number }) {
  if (updateBusy(phase, pending)) return <Loader2 size={size} className="animate-spin" />;
  if (phase === "up-to-date") return <Check size={size} />;
  if (phase === "available" || phase === "downloaded") return <ArrowDownToLine size={size} />;
  return <RefreshCw size={size} />;
}

/** Whether the updater has something the profile row should say out loud.
 * An idle updater, and the three-second "up to date" tick that follows a
 * check the user asked for from inside the menu, both stay in the menu. */
export function updateNoteworthy(phase: UpdatePhase, pending = false): boolean {
  return pending || (phase !== "idle" && phase !== "up-to-date" && phase !== "checking");
}

interface UpdateEntry {
  item: SidebarMenuItem;
  phase: UpdatePhase;
  pending: boolean;
  label: string;
}

/** The updater bridge exists only in the packaged app; in dev the entry is
 * absent rather than dead. */
function useUpdateItem(): UpdateEntry | null {
  const state = useUpdaterState();
  const updater = window.ogb?.updater;
  const [pending, setPending] = useState(false);
  const [checkedAt, setCheckedAt] = useState(0);
  const status = state?.status ?? "idle";

  // download and install both round-trip through main before the status
  // changes — spin on the click itself, and let the new status clear it
  useEffect(() => setPending(false), [status]);

  // a check that found nothing lands back on idle — acknowledge it for 3s
  const upToDate = Boolean(checkedAt) && (!state || state.status === "idle") && Date.now() - checkedAt < 3000;
  useEffect(() => {
    if (!upToDate) return;
    const timer = setTimeout(() => setCheckedAt(0), 3000);
    return () => clearTimeout(timer);
  }, [upToDate]);

  if (!updater) return null;

  const phase = updatePhase(state, upToDate);
  const label = updateLabel(phase, state);
  return {
    phase,
    pending,
    label,
    item: {
      key: "update",
      label,
      icon: <UpdateIcon phase={phase} pending={pending} />,
      disabled: updateBusy(phase, pending),
      // progress is reported on the row itself, so the menu stays put
      keepOpen: true,
      attention: phase === "downloaded" || phase === "error",
      attentionTone: phase === "error" ? "danger" : "accent",
      onSelect: () => {
        if (phase === "downloaded") {
          setPending(true);
          return void updater.install();
        }
        if (phase === "available") {
          setPending(true);
          return void updater.download();
        }
        setCheckedAt(Date.now());
        void updater.check();
      },
    },
  };
}

export function SidebarProfileMenu() {
  const { state, dispatch } = useStore();
  const phone = useSidebarPhoneStatus();
  const update = useUpdateItem();
  const [aboutOpen, setAboutOpen] = useState(false);

  const profile = state.config?.profile;
  const name = profileLabel(profile);

  const items: SidebarMenuItem[] = [
    {
      key: "phone",
      label: phone.pairedCount ? "Your phone" : "Get OpenMausBot for iOS",
      icon: <Smartphone size={18} />,
      trailing:
        phone.kind === "connected" ? (
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-success" />
        ) : undefined,
      onSelect: () => dispatch(phoneSettingsAction()),
    },
    {
      key: "settings",
      label: "Settings",
      icon: <SettingsIcon size={18} />,
      onSelect: () => dispatch({ type: "toggleAppSettings" }),
    },
    ...(update ? [update.item] : []),
    {
      key: "about",
      label: "About",
      icon: <Info size={18} />,
      separatorBefore: true,
      onSelect: () => setAboutOpen(true),
    },
    {
      key: "help",
      label: "Help Center",
      icon: <HelpCircle size={18} />,
      onSelect: () => void openExternalLink(HELP_CENTER_URL),
    },
    {
      key: "feedback",
      label: "Send Feedback",
      icon: <DiscordIcon size={17} />,
      onSelect: () => void openExternalLink(FEEDBACK_URL),
    },
  ];

  return (
    <>
      <SidebarPopoverMenu
        items={items}
        ariaLabel={name}
        renderTrigger={({ open }) => (
          <span
            className={cn(
              "flex min-h-10 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors",
              open ? "bg-raised" : "hover:bg-raised/50",
            )}
          >
            <InitialsAvatar initials={profileInitials(profile)} size={28} />
            <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{name}</span>
            {/* an update is the one thing worth interrupting the name for, so
              * it sits on the row rather than waiting to be found in the menu */}
            {update && updateNoteworthy(update.phase, update.pending) && (
              <span
                title={update.label}
                aria-label={update.label}
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full",
                  update.phase === "error" ? "bg-danger/15 text-danger" : "bg-accent/15 text-accent",
                )}
              >
                <UpdateIcon phase={update.phase} pending={update.pending} size={14} />
              </span>
            )}
          </span>
        )}
      />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </>
  );
}
