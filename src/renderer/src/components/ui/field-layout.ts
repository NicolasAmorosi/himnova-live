import { createContext } from "react";

/**
 * How a `FieldRow` lays itself out:
 *
 * - `spread` — a Settings page: label (and description) on the left, the
 *   control at the far right of a wide row.
 * - `compact` — an editor's inspector (`Inspector`, ~300 px): the label in a
 *   fixed first column and the control right beside it, so the eye never
 *   crosses a wide row to pair them; the description goes under both.
 * - `stacked` — a control too wide to sit beside a label (a long text, an image
 *   picker): label on top, control under it at full width.
 *
 * The inspector sets `compact` for every row inside it through this context,
 * which is what lets the shared knobs (`components/shared/style-fields.tsx`)
 * render in a Settings page and in an inspector without a prop threaded
 * through each of them. A row's own `layout` wins.
 */
export type FieldLayout = "spread" | "compact" | "stacked";
export const FieldLayoutContext = createContext<FieldLayout>("spread");
