import "@fontsource-variable/noto-sans";
import "./styles/globals.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installDropGuard } from "@renderer/lib/drop-guard";
import { ProjectionApp } from "@renderer/projection/ProjectionApp";
import { ProjectorCopy } from "@renderer/components/shared/projector-copy";

installDropGuard();

const container = document.getElementById("root");
if (!container) throw new Error("#root element not found");

/** This page as the NDI® output's offscreen copy of the projection (`main/ndi/ndi-output.ts`). */
const copy = new URLSearchParams(window.location.search).get("role") === "ndi";

/** The verse's auto-fit measures text, and this window draws none before its first verse: measured with the fallback
 *  font, a long verse came out cut once Noto swapped in (2026-11-15 audit, A15). So its latin subset loads first, a few
 *  ms from disk. Capped, so a font that never answers cannot keep the projector black; the fit measures again when a
 *  font arrives anyway (`useFittedTextSize`). */
const notoReady = Promise.race([
  document.fonts.load('1em "Noto Sans Variable"'),
  new Promise((resolve) => setTimeout(resolve, 1000)),
]).catch(() => undefined);

void notoReady.then(() =>
  createRoot(container).render(
    <StrictMode>
      {copy ? (
        <div className="h-screen w-screen bg-black">
          <ProjectorCopy />
        </div>
      ) : (
        <ProjectionApp />
      )}
    </StrictMode>,
  ),
);
