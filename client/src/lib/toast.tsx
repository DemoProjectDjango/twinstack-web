"use client";

// Notifications go through this `toast` (react-toastify's, with the same API); yes/no questions use
// confirmModal (lib/confirm.tsx).
import type { ReactNode } from "react";
import { toast as base, type ToastContent, type ToastOptions, type UpdateOptions, type Id } from "react-toastify";

/**
 * react-toastify puts a toast's text straight into the toast, so it's wrapped here for globals.css
 * to hold it to two lines (`.toast-text`). Render functions are left as they are.
 */
function wrap<T>(content: ToastContent<T>): ToastContent<T> {
  if (typeof content === "function" || content === null || content === undefined || content === false) return content;
  return <div className="toast-text">{content as ReactNode}</div>;
}

type Show = <T = unknown>(content: ToastContent<T>, options?: ToastOptions<T>) => Id;
const wrapped =
  (show: Show): Show =>
  (content, options) =>
    show(wrap(content), options);

export const toast = Object.assign(wrapped(base as Show), base, {
  success: wrapped(base.success),
  error: wrapped(base.error),
  info: wrapped(base.info),
  warning: wrapped(base.warning),
  warn: wrapped(base.warn),
  loading: wrapped(base.loading),
  update: <T = unknown,>(id: Id, options: UpdateOptions<T> = {}) =>
    base.update(id, "render" in options && options.render !== undefined ? { ...options, render: wrap(options.render as ToastContent<T>) as UpdateOptions<T>["render"] } : options),
});
