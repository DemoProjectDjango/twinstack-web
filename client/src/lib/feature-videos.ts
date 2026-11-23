// Short videos for "Learn the features" (components/site/FeatureGuide.tsx), one per step.
//
// To add one, put its link next to the step's id below and remove the `//`. A step with a link
// gets a "▶ Watch" button that plays it over the editor. A link can be:
//   - YouTube: "https://www.youtube.com/watch?v=…", "https://youtu.be/…" or a Shorts link
//     (an "Unlisted" video is fine: only people with the link can find it)
//   - Vimeo:   "https://vimeo.com/123456789"
//   - a video file: any https address ending in .mp4 or .webm, or a file you put in
//     client/public/videos/ written as "/videos/<name>.mp4" (keep these small: they ship with
//     the app on every deploy)
// Steps without a link simply show no button.

export const FEATURE_VIDEOS: Partial<Record<string, string>> = {
  // Edit site
  // "edit-text": "",        Change some words
  // "preview-page": "",     Look at another page
  // "ask-section": "",      Change a whole section
  // "try-links": "",        Click around like a visitor
  // "phone": "",            See it on a phone
  // "full-size": "",        Open it full size
  // "todo": "",             Your to-do list
  // Chat with the AI
  // "ai": "",               Ask the AI
  // "ai-attach": "",        Give it files
  // "chat-panel": "",       The full chat
  // "pictures": "",         Pictures and logos
  // Pages
  // "pages": "",            All your pages
  // "page-add": "",         Add a page
  // "page-open": "",        Edit a whole page
  // "page-menu": "",        Menu, hide, delete
  // "page-on-site": "",     Jump to it on your site
  // "find": "",             Find any page
  // Look & logo
  // "design": "",           How your site looks
  // "brand": "",            Logo and tab icon
  // "header-footer": "",    Header and footer
  // Business info
  // "details": "",          Your business details
  // "details-tab": "",      Contact, social, reviews, FAQ
  // Your domain
  // "domain": "",           Your own web address
  // "domain-how": "",       How connecting works
  // Visitors
  // "analytics": "",        Who visits
  // "analytics-more": "",   Dig into the numbers
  // More tools
  // "seo": "",              Found on Google
  // "schedule": "",         Planned posts
  // "files": "",            Files
  // "memory": "",           AI notes about your site
  // "styles": "",           Custom code
  // "models": "",           AI settings
  // "tree": "",             Page plan
  // "log": "",              Technical log
  // Publish
  // "publish": "",          What's changed
  // "undo": "",             Undo what you don't want
  // "versions": "",         Earlier versions
  // "publish-button": "",   Publish
  // "updates": "",          Site updates and credits
};
