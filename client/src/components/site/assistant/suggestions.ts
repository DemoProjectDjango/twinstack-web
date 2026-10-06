import type { SiteSection } from "../site-context";

// What to suggest asking Claude on each screen: a placeholder for the box, and a few examples
// the owner can send with one click.

export const SUGGESTIONS: Record<SiteSection | "page", { placeholder: string; items: string[] }> = {
  home: {
    placeholder: "Tell Claude what you'd like to change on your site…",
    items: ["What should I do next to finish my site?", "Make the homepage headline friendlier", "Add a Contact page with our email and phone number"],
  },
  pages: {
    placeholder: "Add or change a page just by describing it…",
    items: ["Add an About us page about our family bakery, founded in 1990", "Add a blog post announcing our new opening hours", "Rewrite the Services page in a warmer tone"],
  },
  page: {
    placeholder: "Ask Claude to change this page…",
    items: ["Make this page shorter and easier to read", "Add a short FAQ section at the end", "Improve how this page shows up in Google"],
  },
  design: {
    placeholder: "Change the menu, footer or logo by describing it…",
    items: ["Add our Blog to the main menu", "Make the header dark", "Add Privacy and Terms links to the footer"],
  },
  details: {
    placeholder: "Update your business details…",
    items: ["Our phone number is now 020 7946 0000", "Change our tagline to something more welcoming", "Add our Instagram page"],
  },
  publish: {
    placeholder: "Ask about your changes, or to publish them…",
    items: ["What have I changed since I last published?", "Publish my changes"],
  },
  seo: {
    placeholder: "Tell Claude what to improve in search results…",
    items: ["Write search titles and descriptions for every page", "Which pages need the most work for Google?", "Improve how the homepage shows up in Google"],
  },
  tree: {
    placeholder: "Tell Claude which pages you want…",
    items: ["Add a Careers page and a Team page", "Plan a site for a small bakery: home, menu, about, contact", "Add a Blog section with three first posts"],
  },
  schedule: {
    placeholder: "Plan pages for later…",
    items: ["Schedule a blog post for next Monday about our summer menu", "What's scheduled at the moment?"],
  },
  memory: {
    placeholder: "Tell Claude something to always remember…",
    items: ["Always write in British English", "Our audience is busy parents; keep it simple", "What do you know about my site so far?"],
  },
  styles: {
    placeholder: "Describe a style change…",
    items: ["Make the buttons rounder", "Use a slightly larger font for paragraphs"],
  },
  tools: {
    placeholder: "Ask Claude about your site…",
    items: ["Why might my site not be updating?"],
  },
};
