"use client";

import { useEffect, useState } from "react";

/**
 * A chosen image file as a data: URL, for showing it before it's uploaded (the setup's logo and tab
 * icon, the header and footer preview). Null until it's read, and for no file. A data URL, not an
 * object URL: React runs effects twice in development, which revoked an object URL before it was drawn.
 */
export function useFileUrl(file: File | null) {
  const [read, setRead] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    if (!file) return;
    let live = true;
    const reader = new FileReader();
    reader.onload = () => {
      if (live && typeof reader.result === "string") setRead({ file, url: reader.result });
    };
    reader.readAsDataURL(file);
    return () => {
      live = false;
    };
  }, [file]);
  return file && read?.file === file ? read.url : null;
}
