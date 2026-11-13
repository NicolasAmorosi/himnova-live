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
);
