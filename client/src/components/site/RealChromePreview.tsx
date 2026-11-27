"use client";

import { useEffect, useRef, useState } from "react";
import { useSite } from "./site-context";

// The site's real header and footer, as its built preview shows them: for a header and footer the AI
// designed or that were copied from a website, whose look the template-colour approximation
// (HeaderFooterPreview) can't show. Two views of the homepage: its top, and its bottom (the frame's
// script scrolls there when asked, inline-edit.js).

const SOURCE = "twinstack-preview";
const WIDTH = { desktop: 1280, mobile: 390 } as const;
// The footer view is taller: a header fixed to the top of the window covers the top of it.
const HEIGHT = { header: 200, footer: 900 } as const;

function Frame({ src, device, part }: { src: string; device: "desktop" | "mobile"; part: "header" | "footer" }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  const width = WIDTH[device];
  const scale = boxWidth ? Math.min(1, boxWidth / width) : 1;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setBoxWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The footer view goes to the bottom once the page is ready, and again after late images settle.
  useEffect(() => {
    if (part !== "footer") return;
    const toBottom = () => frame.current?.contentWindow?.postMessage({ source: SOURCE, type: "scroll", ratio: 1 }, "*");
    const onMessage = (event: MessageEvent) => {
      if (event.source === frame.current?.contentWindow && event.data?.source === SOURCE && event.data?.type === "ready") {
        toBottom();
        setTimeout(toBottom, 800);
        setTimeout(toBottom, 2500);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [part, src]);

  const height = HEIGHT[part];
  return (
    // The frame is positioned out of the flow, so its own width never widens the box it's measured in.
    <div ref={box} className="relative mx-auto w-full min-w-0 overflow-hidden rounded-md border border-zinc-200 bg-white dark:border-zinc-800" style={{ height: height * scale, maxWidth: width }}>
      <iframe
        ref={frame}
        key={`${src}-${device}`}
        src={src}
        title={part === "header" ? "Your header as visitors see it" : "Your footer as visitors see it"}
        sandbox="allow-scripts"
        tabIndex={-1}
        className="pointer-events-none absolute left-0 top-0 origin-top-left border-0"
        style={{ width, height, transform: `scale(${scale})` }}
      />
    </div>
  );
}

export function RealChromePreview({ device }: { device: "desktop" | "mobile" }) {
  const { status, version } = useSite();
  if (!status?.previewUrl) {
    return <p className="text-sm text-zinc-500">The preview appears here once your site has been built (Edit site builds it by itself).</p>;
  }
  // A new build after each change shows the latest look.
  const src = `${status.previewUrl.replace(/\/+$/, "")}/?v=${version}`;
  return (
    <div className="grid gap-3">
      <div>
        <span className="mb-1 block text-xs font-medium text-zinc-500">Header</span>
        <Frame src={src} device={device} part="header" />
      </div>
      <div>
        <span className="mb-1 block text-xs font-medium text-zinc-500">Footer</span>
        <Frame src={src} device={device} part="footer" />
      </div>
    </div>
  );
}
