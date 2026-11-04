/**
 * RTF → plain text, for the lyrics other programs store as RTF (EasyWorship's
 * `SongWords.db`). A tokenizer, not a regex over the whole thing: groups nest,
 * a `{\*…}` group or a font table is never text, `\uN` carries a character and
 * then skips its fallback, and `\'xx` is a byte in the document's code page.
 *
 * The approach is OpenLP's `strip_rtf` (GPL-3.0-or-later, by the OpenLP
 * developers, after MizardX's answer on Stack Overflow), written anew here.
 */
import { TextDecoder } from "node:util";

/** Groups whose whole content is metadata, never text. */
const DESTINATIONS = new Set([
  "fonttbl",
  "colortbl",
  "stylesheet",
  "info",
  "pict",
  "object",
  "header",
  "headerl",
  "headerr",
  "footer",
  "footerl",
  "footerr",
  "footnote",
  "fldinst",
  "listtable",
  "listoverridetable",
  "rsidtbl",
  "generator",
  "themedata",
  "colorschememapping",
  "latentstyles",
  "datastore",
  "xmlnstbl",
  "pntext",
  "pntxta",
  "pntxtb",
]);

/** Control words that stand for a character. */
const CHARACTERS: Record<string, string> = {
  par: "\n",
  line: "\n",
  tab: "\t",
  emdash: "—",
  endash: "–",
  emspace: " ",
  enspace: " ",
  bullet: "•",
  lquote: "‘",
  rquote: "’",
  ldblquote: "“",
  rdblquote: "”",
  // EasyWorship 7 marks where one of its slides ends (FreeShow reads it so).
  sdslidemarker: "\n\n",
};

const TOKEN = /\\([a-zA-Z]{1,32})(-?\d{1,10})? ?|\\'([0-9a-fA-F]{2})|\\([^a-zA-Z])|([{}])|[\r\n]+|([^\\{}\r\n]+)/g;

type GroupState = { ignorable: boolean; ucSkip: number };

function decoderFor(codePage: number): TextDecoder {
  try {
    return new TextDecoder(`windows-${codePage}`);
  } catch {
    return new TextDecoder("windows-1252");
  }
}

export function rtfToText(rtf: string): string {
  const out: string[] = [];
  const stack: GroupState[] = [];
  let state: GroupState = { ignorable: false, ucSkip: 1 };
  let decoder = decoderFor(1252);
  /** Characters still to drop after a `\uN` — its fallback. */
  let skip = 0;
  const emit = (text: string) => {
    if (!state.ignorable) out.push(text);
  };

  for (const match of rtf.matchAll(TOKEN)) {
    const [, word, param, hex, symbol, brace, text] = match;
    if (brace === "{") {
      stack.push(state);
      state = { ...state };
      skip = 0;
      continue;
    }
    if (brace === "}") {
      state = stack.pop() ?? state;
      skip = 0;
      continue;
    }
    if (word !== undefined) {
      const value = param === undefined ? null : Number(param);
      if (skip > 0) {
        // A control word counts as one character of a `\uN`'s fallback.
        skip -= 1;
        continue;
      }
      if (DESTINATIONS.has(word)) state.ignorable = true;
      else if (word === "ansicpg" && value !== null) decoder = decoderFor(value);
      else if (word === "uc" && value !== null) state.ucSkip = value;
      else if (word === "u" && value !== null) {
        emit(String.fromCharCode(value < 0 ? value + 65_536 : value));
        skip = state.ucSkip;
      } else if (CHARACTERS[word]) emit(CHARACTERS[word]);
      continue;
    }
    if (hex !== undefined) {
      if (skip > 0) {
        skip -= 1;
        continue;
      }
      emit(decoder.decode(new Uint8Array([parseInt(hex, 16)])));
      continue;
    }
    if (symbol !== undefined) {
      if (symbol === "*") state.ignorable = true;
      else if (symbol === "~") emit(" ");
      else if (symbol === "_") emit("-");
      else if (symbol === "\\" || symbol === "{" || symbol === "}") emit(symbol);
      continue;
    }
    if (text !== undefined) {
      if (skip > 0) {
        const dropped = Math.min(skip, text.length);
        skip -= dropped;
        emit(text.slice(dropped));
      } else {
        emit(text);
      }
      continue;
    }
    // What is left is a raw line break of the source, which is not one of the text.
  }
  return out.join("");
}
