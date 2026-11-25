import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { CheckoutReturn } from "@/components/CheckoutReturn";
import { HideInSiteEditor } from "@/components/HideInSiteEditor";
import { Navbar } from "@/components/Navbar";
import { THEME_SCRIPT } from "@/components/ThemeToggle";
import { Toaster } from "@/components/Toaster";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Twinstack",
  description: "Build your website step by step, make it yours, and publish it with one click. No code needed.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The theme script sets the `dark` class before React does, so the class differs from the server's.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* The chosen colours, applied before the first paint (ThemeToggle.tsx). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <HideInSiteEditor>
          <Navbar />
        </HideInSiteEditor>
        {children}
        <Toaster />
        <CheckoutReturn />
      </body>
    </html>
  );
}
