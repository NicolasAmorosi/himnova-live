import { useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { BrandMark, Button, Icon, IconButton, Toolbar, Tooltip } from "@renderer/components/ui";
import { useProjectionStore } from "@renderer/stores/projection.store";
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
      <Toolbar className="grid grid-cols-3 items-center">
        {/* The program's name as plain text, and «Save» with its word
            (2026-11-04 redesign, P7): saving Saturday's program was a 16 px
            icon, and the name floated in a capsule. */}
        <div className="flex min-w-0 items-center gap-1.5">
          <BrandMark className="mx-1 size-7 shrink-0 rounded-md" />
          <Tooltip content={t("settings.title")} floating>
            <IconButton aria-label={t("settings.title")} onClick={onOpenSettings} variant="ghost">
              <Icon name="settings" />
            </IconButton>
          </Tooltip>

          <div className="mx-1 h-5 w-px shrink-0 bg-border" />

          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={currentProgramName || t("programs.new")}>
            {currentProgramName || t("programs.new")}
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

        <div className="flex items-center justify-end">
          <Button disabled={previewContent === null} onClick={() => void goLive()} size="md" variant="live">
            <Icon name="play" /> {t("actions.goLive")}
          </Button>
        </div>

        <div className="flex items-center justify-end gap-1.5">
          <Button
            className="w-24 px-2"
            onClick={() => void setOverlayDirect("logo")}
            size="md"
            toggled={overlay === "logo"}
            variant="outline"
          >
            <Icon name="image" /> {t("footer.logo")}
          </Button>
          <Button
            className="w-24 px-2"
            onClick={() => void setOverlayDirect("black")}
            size="md"
            toggled={overlay === "black"}
            variant="outline"
          >
            <Icon name="stop" /> {t("footer.black")}
          </Button>
          <Button
            className="w-24 px-2"
            disabled={base === null}
            onClick={() => void setOverlayDirect("none")}
            size="md"
            toggled={overlay === "none"}
            variant="outline"
          >
            <Icon name="play" /> {t("footer.live")}
          </Button>
        </div>
      </Toolbar>
      <ConfirmModal
        confirmLabel={t("programs.discardAndNew")}
        description={t("programs.discardWarning")}
        onConfirm={newProgram}
        onOpenChange={setConfirmNew}
        open={confirmNew}
        title={t("programs.discardTitle")}
      />
    </>
  );
}
