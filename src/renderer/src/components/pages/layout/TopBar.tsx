import { useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { BrandMark, Button, Icon, IconButton, Kbd, Toolbar, Tooltip } from "@renderer/components/ui";
import { selectOutputMemo, useProjectionStore } from "@renderer/stores/projection.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { goLive, setOverlayDirect } from "@renderer/lib/actions/playback";
import { hasUnsavedChanges, newProgram, saveCurrentProgram } from "@renderer/lib/actions/programs";
import { ConfirmModal } from "@renderer/components/shared/modal";
import { usePreviewContent } from "@renderer/lib/hooks/use-preview";

type TopBarProps = {
  onOpenPrograms: (opts?: { mode: "create" }) => void;
  onOpenSettings: () => void;
};

/**
 * Chrome bar, laid out in the same three columns as the workspace below it so
 * each group of controls sits exactly above the column it acts on:
 *
 *   col 1 (schedule/resources) — the mark, settings, the program: name, Save, New, Programs
 *   col 2 (slides)             — GO LIVE: preview -> live, right now
 *   col 3 (monitors)           — BLACK / LOGO / LIVE: what the projector shows
 *
 * Screen selection, theme and logo all live in Settings now — this bar only
 * ever changes what is on the projector, never how the app is configured.
 */
export function TopBar({ onOpenPrograms, onOpenSettings }: TopBarProps) {
  const t = useT();
  const overlay = useProjectionStore((s) => s.overlay);
  const presentationOpen = useProjectionStore((s) => s.presentationOpen);
  // Lit by what the projector SHOWS, read off the same output the monitor
  // draws: with nothing live the room sees the logo, and LOGO said nothing
  // (2026-11-05 review; `useLiveStatus` warns against re-deriving it by hand).
  const outputKind = useProjectionStore((s) => selectOutputMemo(s).kind);
  const base = useProjectionStore((s) => s.base);
  const previewContent = usePreviewContent();
  const currentProgramId = useProgramStore((s) => s.currentProgramId);
  const currentProgramName = useProgramStore((s) => s.currentProgramName);
  const dirty = useProgramStore((s) => s.dirty);
  // A save is a round-trip (write, then re-read the saved row). Nothing marked
  // that window, so a second click inside it sent a second `programs:save` for
  // the same schedule — two writes racing, and the second one re-hydrating the
  // store from whichever finished last.
  const [saving, setSaving] = useState(false);

  function handleQuickSave() {
    if (currentProgramId === null) {
      onOpenPrograms({ mode: "create" });
      return;
    }
    if (saving) return;
    setSaving(true);
    // `saveCurrentProgram` reports its own failure as a toast, so there is
    // nothing to catch here — only the busy flag to put back.
    void saveCurrentProgram().finally(() => setSaving(false));
  }

  // Unsaved work is only thrown away when the operator says so, with the same
  // small dialog every other «discard?» uses (2026-11-04 review: it was a toast
  // with an action here and a dialog everywhere else).
  const [confirmNew, setConfirmNew] = useState(false);
  function handleNewProgram() {
    if (hasUnsavedChanges()) setConfirmNew(true);
    else newProgram();
  }

  return (
    <>
      {/* The columns' own grid (`AppShell`: thirds, 1 px apart) and their
          headers' 12 px edges, so each group ends where its column does. */}
      <Toolbar className="grid grid-cols-3 items-center gap-px px-0">
        {/* The program's name as plain text, and «Save» with its word
            (2026-11-04 redesign, P7): saving Saturday's program was a 16 px
            icon, and the name floated in a capsule. */}
        <div className="flex min-w-0 items-center gap-1.5 px-3">
          <BrandMark className="mr-1 size-7 shrink-0 rounded-md" />
          <Tooltip content={t("settings.title")} floating>
            <IconButton aria-label={t("settings.title")} onClick={onOpenSettings} variant="ghost">
              <Icon name="settings" />
            </IconButton>
          </Tooltip>

          <div className="mx-1 h-5 w-px shrink-0 bg-border" />

          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={currentProgramName || t("header.untitled")}>
            {currentProgramName || t("header.untitled")}
          </span>

          <Tooltip content={dirty ? t("programs.saveHint") : t("programs.saveNoChanges")} floating>
            <Button
              aria-busy={saving || undefined}
              disabled={!dirty || saving}
              onClick={handleQuickSave}
              size="sm"
              variant="outline"
            >
              <Icon name="save" />
              {t("programs.save")}
            </Button>
          </Tooltip>
          <Tooltip content={t("programs.newHint")} floating>
            <IconButton aria-label={t("programs.new")} onClick={handleNewProgram} variant="ghost">
              <Icon name="filePlus" />
            </IconButton>
          </Tooltip>
          <Tooltip content={t("programs.manage")} floating>
            <IconButton aria-label={t("programs.manage")} onClick={() => onOpenPrograms()} variant="ghost">
              <Icon name="folderOpen" />
            </IconButton>
          </Tooltip>
        </div>

        {/* 32 px like every control of a bar, not the 40 of what is pressed
            during a service: the bar is a strip tall like all the others
            (owner, 2026-11-06). They keep their width and their words. */}
        <div className="flex items-center justify-end px-3">
          <Tooltip content={<>{t("footerHints.goLive")}<Kbd>Enter</Kbd></>} floating>
            <Button disabled={previewContent === null} onClick={() => void goLive()} size="sm" variant="live">
              <Icon name="play" /> {t("actions.goLive")}
            </Button>
          </Tooltip>
        </div>

        <div className="flex items-center justify-end gap-1.5 px-3">
          <Tooltip content={<>{t("footerHints.logo")}<Kbd>L</Kbd></>} floating>
            <Button
              className="w-24 px-2"
              onClick={() => void setOverlayDirect("logo")}
              size="sm"
              toggled={outputKind === "logo"}
              toggledTone="warning"
              variant="outline"
            >
              <Icon name="image" /> {t("footer.logo")}
            </Button>
          </Tooltip>
          <Tooltip content={<>{t("footerHints.black")}<Kbd>B</Kbd></>} floating>
            <Button
              className="w-24 px-2"
              onClick={() => void setOverlayDirect("black")}
              size="sm"
              toggled={outputKind === "black"}
              toggledTone="warning"
              variant="outline"
            >
              <Icon name="stop" /> {t("footer.black")}
            </Button>
          </Tooltip>
          <Tooltip content={t("footerHints.live")} floating>
            <Button
              className="w-24 px-2"
              disabled={base === null}
              onClick={() => void setOverlayDirect("none")}
              size="sm"
              // Lit only while content IS on the projector, and with its own
              // icon: the ▷ of GO LIVE beside it read as a second GO LIVE, lit
              // all service long — even with nothing live (2026-11-05 review;
              // the owner kept its word, VIVO).
              toggled={presentationOpen && overlay === "none" && base !== null}
              toggledTone="onAir"
              variant="outline"
            >
              <Icon name="display" /> {t("footer.live")}
            </Button>
          </Tooltip>
        </div>
      </Toolbar>
      <ConfirmModal
        confirmLabel={t("programs.discardAndNew")}
        danger
        description={t("programs.discardWarning")}
        onConfirm={newProgram}
        onOpenChange={setConfirmNew}
        open={confirmNew}
        title={t("programs.discardTitle")}
      />
    </>
  );
}
