import { useEffect, useState, type DragEvent } from "react";
import { useI18n } from "@renderer/lib/i18n/i18n-provider";
import { Caption, Icon, IconButton, Input, Menu, Token } from "@renderer/components/ui";
import { SECTION_FILL } from "@renderer/components/shared/song-section-fill";
import { cn } from "@renderer/lib/utils";
import { hideDragGhost } from "@renderer/lib/dnd";
import { formatOrder, parseOrder, parseSectionKey, sectionLabel } from "@shared/song-text";
import type { SongSection } from "@shared/types/song";

/** A chip being dragged inside the row — its position, never leaving it. */
const ORDER_CHIP_MIME = "application/x-worship-song-order-chip";

type SongOrderFieldProps = {
  /** The order as shown: the text's own while it is not the operator's. */
  order: readonly string[];
  /** The operator set it (`SongDraft.order !== null`). */
  custom: boolean;
  onChange: (order: string[]) => void;
  /** Back to following the text. */
  onReset: () => void;
  sections: readonly SongSection[];
};

/**
 * The song's one order (owner, 2026-11-04: how many times and when the chorus
 * goes is the operator's): chips — drag to move, × to remove — with a «+»
 * that adds a section once more. The same order as a line of text
 * («E1 C E2 C P C C»), for whoever types faster than they drag, and «follow
 * the lyrics» live in its «⋯» (owner, 2026-11-05: chips, a row of «Add:»
 * chips and a text field were three ways to do one thing at once).
 */
export function SongOrderField({ custom, onChange, onReset, order, sections }: SongOrderFieldProps) {
  const { locale, t } = useI18n();
  const formatted = formatOrder(order, locale);
  const [text, setText] = useState(formatted);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [typing, setTyping] = useState(false);
  const known = new Set(sections.map((section) => section.key));

  // The chips moved: the line follows, unless it is the one being typed in.
  useEffect(() => {
    setText((current) => (formatOrder(parseOrder(current, locale).keys, locale) === formatted ? current : formatted));
  }, [formatted, locale]);

  const labelOf = (key: string) => {
    const parsed = parseSectionKey(key);
    return parsed ? sectionLabel(parsed.type, parsed.number, locale) : key;
  };

  function handleDrop(e: DragEvent, at: number) {
    e.preventDefault();
    setDropAt(null);
    const raw = e.dataTransfer.getData(ORDER_CHIP_MIME);
    if (raw === "") return;
    const from = Number(raw);
    const next = [...order];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(from < at ? at - 1 : at, 0, moved);
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-2">
      <ul
        aria-label={t("songs.orderLabel")}
        className="flex min-h-9 flex-wrap items-center gap-1.5"
        onDragOver={(e) => {
          e.preventDefault();
          setDropAt(order.length);
        }}
        onDrop={(e) => handleDrop(e, order.length)}
      >
        {order.map((key, index) => {
          const parsed = parseSectionKey(key);
          return (
            <li
              className={cn("flex items-center", dropAt === index && "rounded-md ring-2 ring-accent")}
              draggable
              // Position, not key: the same section is in the order many times.
              key={`${key}-${index}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDropAt(index);
              }}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData(ORDER_CHIP_MIME, String(index));
                hideDragGhost(e);
              }}
              onDragEnd={() => setDropAt(null)}
              onDrop={(e) => {
                e.stopPropagation();
                handleDrop(e, index);
              }}
              title={labelOf(key)}
            >
              <Token className="cursor-grab gap-1.5 pr-0.5" danger={!known.has(key)}>
                <span className={cn("size-2 rounded-full", parsed ? SECTION_FILL[parsed.type] : "bg-danger")} />
                {formatOrder([key], locale)}
                <IconButton
                  aria-label={t("songs.orderRemove", { section: labelOf(key) })}
                  onClick={() => onChange(order.filter((_, i) => i !== index))}
                  size="xs"
                  variant="ghost"
                >
                  <Icon name="close" />
                </IconButton>
              </Token>
            </li>
          );
        })}
        <li className="flex items-center gap-0.5">
          <Menu
            align="start"
            icon="add"
            label={t("songs.orderAdd")}
            onSelect={(key) => onChange([...order, key])}
            options={sections.map((section) => ({
              label: `${formatOrder([section.key], locale)} · ${sectionLabel(section.type, section.number, locale)}`,
              value: section.key,
            }))}
          />
          <Menu
            align="start"
            icon="more"
            label={t("songs.orderMore")}
            onSelect={(command) => {
              if (command === "typing") setTyping((shown) => !shown);
              else onReset();
            }}
            options={[
              { label: t("songs.orderTyping"), value: "typing" },
              { disabled: !custom, label: t("songs.orderReset"), value: "reset" },
            ]}
          />
        </li>
      </ul>

      {typing || invalid.length > 0 ? (
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">
            <Input
              aria-invalid={invalid.length > 0 || undefined}
              aria-label={t("songs.orderText")}
              onBlur={() => {
                setText(formatted);
                setInvalid([]);
              }}
              onChange={(e) => {
                setText(e.target.value);
                const parsed = parseOrder(e.target.value, locale);
                setInvalid(parsed.invalid);
                if (parsed.invalid.length === 0) onChange(parsed.keys);
              }}
              placeholder={t("songs.orderPlaceholder")}
              size="sm"
              value={text}
            />
          </div>
        </div>
      ) : null}
      {invalid.length > 0 ? (
        <Caption className="text-danger-ink">{t("songs.orderInvalid", { tokens: invalid.join(" ") })}</Caption>
      ) : (
        <Caption>{custom ? t("songs.orderCustomHint") : t("songs.orderTextHint")}</Caption>
      )}
    </div>
  );
}
