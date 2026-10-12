// How big a Claude request is, from its instruction, so the cheaper model (config.fastPageModel,
// TWINSTACK_FAST_MODEL) only gets the small ones. Rules only: no request, no cost, the same answer
// every time. The route passes the result to the copy's scripts as TWINSTACK_TASK_SIZE.
//
// - small: wording and facts, removing, hiding or moving things, a one-property style tweak.
//   The cheaper model does it, even on a page with no design yet.
// - complex: interactive features, animations and effects, scripts, forms, redesigns, layout and
//   mobile fixes, new designed sections with moving parts. Claude does it from the start.
// - standard: in between (a plain new section, a rewrite). The scripts' own rules decide, as before
//   sizing existed: the cheaper model when there's a design to follow, Claude taking over on failure.
//
// The assistant knows the conversation behind its instruction, so its own label (`hint`) wins.
//
// A request is split into clauses, one per thing asked for. Each clause is scored from its verb
// (what kind of change) and the words in it (what it changes); the request takes its hardest
// clause, plus a little for each further real change, its length and attached images.

export const TASK_SIZES = ["small", "standard", "complex"];

const COMPLEX_AT = 3;
const SMALL_UP_TO = 1;

// Leading words that aren't the request itself.
const POLITE =
  /^(?:(?:please|pls|plz|kindly|ok(?:ay)?|hi|hey|now|also|then|and|so|just|can (?:you|u|we)|could (?:you|u|we)|would (?:you|u)|will (?:you|u)|i(?:'d| would)? (?:like|want|need) (?:you )?to|i want|i need|we need to|let's|lets|go ahead and|try to|help me)\b[\s,]*)+/;

// Verb classes, checked against the clause's first words. Each has a base score.
const VERBS = [
  // A redesign is complex whatever it touches.
  { kind: "redesign", base: 4, re: /^(?:re-?design|revamp|overhaul|rebuild|re-?style|restyle|modernis|moderniz|re-?imagine|re-?work|rework|restructure|give (?:it|the \w+(?: \w+)?|this(?: \w+)?) a (?:new|fresh|modern|whole new|complete) (?:look|design|feel|style)|refresh the (?:look|design|style))/ },
  { kind: "remove", base: 0, re: /^(?:remove|delete|hide|drop|get rid of|take (?:[\w'-]+ ){0,4}?(?:out|away|off|down)\b|cut|strip|disable|turn off|switch off|erase|clear|unpublish|eliminate|lose|kill|comment out)\b/ },
  { kind: "move", base: 1, re: /^(?:move|reorder|re-order|rearrange|re-arrange|put .{1,60}\b(?:above|below|before|after|under|over|next to|first|last|at the (?:top|bottom|end|start))|swap the (?:order|position))/ },
  { kind: "replace", base: 1, re: /^(?:replace|swap|switch|substitute|exchange)\b/ },
  // "redo the heading text" is a wording change; "redo the whole page" a redesign.
  { kind: "redesign", base: 4, re: /^(?:redo|re-do|remake|freshen up|spruce up|jazz up|glam up)\b(?=.*\b(?:page|site|website|section|hero|homepage|design|layout|look|style|whole|entire|it|this)\b)/ },
  // Making something whose look or behaviour has to be worked out.
  { kind: "build", base: 2, re: /^(?:design|implement|develop|integrate|embed|code|program|engineer)\b/ },
  { kind: "build", base: 1, re: /^(?:create|build|set up|setup|introduce|make (?:a|an|new|some)\b|construct|craft)\b/ },
  { kind: "add", base: 1, re: /^(?:add|insert|include|put|append|prepend|show|display|list|attach|place|feature|highlight|link|mention|bring in|throw in|stick)\b/ },
  { kind: "rewrite", base: 1, re: /^(?:rewrite|re-write|write|translate|expand|elaborate|flesh out|summari[sz]e|draft|compose|reword|rephrase|paraphrase)\b/ },
  { kind: "text", base: 0, re: /^(?:change|update|edit|fix|correct|rename|set|shorten|lengthen|proofread|adjust|tweak|amend|modify|revise|alter|make|turn|use|keep|increase|decrease|reduce|enlarge|shrink|bump|lower|raise|capitali[sz]e|bold|italici[sz]e|underline|center|centre|align|resize|recolou?r|colou?r|darken|lighten|spell|check)\b/ },
];

// A new look asked for in other words ("make the page look more modern").
const REDESIGN_PHRASE =
  /\b(?:(?:look|feel)s? (?:more |a lot |much |really |very |a bit |far )?(?:modern|professional|premium|elegant|sleek|stylish|beautiful|better|nicer|fresh|polished|luxur\w+|high-end|striking|eye-catching|appealing|attractive|amazing|stunning|creative|unique|fancy|cool|trendy|impressive|expensive|corporate|playful)|new (?:look|design|style|feel)|make-?over|face-?lift|improve the (?:design|look|layout|ui|ux)|better (?:design|layout|look)|make (?:it|this|the \w+(?: \w+)?) pop|wow factor|looks? (?:boring|dated|old|outdated|plain|bland|cheap|ugly|amateur\w*|basic|dull|messy|cluttered)\b|look(?:s)? like (?:apple|stripe|airbnb|linear|notion|vercel|(?:an? |the )?[\w'-]+(?: [\w'-]+){0,2} (?:page|site|website|template|design|app|store|brand)\b))/;

// The reminders the assistant adds to every instruction ("make sure it still works on phones",
// "keep everything else as it is"): not a change of their own.
const REMINDER =
  /^(?:(?:make sure|ensure|check|confirm|remember|note|it (?:must|should|has to|needs to)|this (?:must|should)|must|should|everything (?:must|should)|all of (?:it|this) (?:must|should)|and)\b.{0,80}\b(?:works?|look(?:s)? (?:right|good|fine|great)|readable|responsive|usable|easy to use|fits?)\b.{0,60}\b(?:phones?|mobile|tablets?|computers?|desktops?|laptops?|screens?|devices?|sizes?)\b|keep (?:everything|the rest|all|anything|every other)\b.{0,60}\b(?:as it is|as is|the same|unchanged|untouched|exactly)\b|(?:don't|do not) (?:change|touch|alter) (?:anything|the rest|other)\b)/;

// A limit on the rest of the request ("don't use any effects"): nothing to do of its own.
const CONSTRAINT = /^(?:don't|dont|do not|no|never|avoid|without|nothing|leave|only)\b/;

// The owner telling a fact rather than asking for a change: "we moved!", "our hours changed".
const STATEMENT = /^(?:we|we're|we've|we'll|our|i|i'm|i've|my|it's|its|this is|that's|there's|there is|they|the (?:\w+ ){0,3}(?:is|are|was|were|has|have) (?:now|wrong|old|out of date|outdated|incorrect|changed|moved|closed|gone))\b/;

// Verbs that only ever change words: "shorten it", "proofread the page".
const WORDING_VERB = /^(?:shorten|lengthen|proofread|reword|rephrase|paraphrase|correct|spell|capitali[sz]e|translate|tone down|simplify the (?:text|wording|language)|summari[sz]e)\b/;

// Layout nouns: making one is design work, adjusting one ("make the cards smaller") isn't.
const LAYOUT_NOUN = /\b(?:cards?|tiles?|columns|two-column|three-column|side[- ]by[- ]side|split screen|split layout|timeline|stepper|feature grid)\b/;

// What a clause works on.
const FEATURES = [
  // Interactivity and scripts.
  /\binteractiv\w*/,
  /\b(?:on[- ]?click|clickable|click(?:ing)? (?:on|to|reveals?|opens?|shows?|expands?))/,
  /\bhover(?:ing)?\b/,
  /\banimat\w*/,
  /\b(?:effects?|fx)\b/,
  /\btransitions?\b/,
  /\bparallax\b/,
  /\bcarousels?\b/,
  /\bsliders?\b/,
  /\bslide-?shows?\b/,
  /\bswip\w+/,
  /\blightbox\w*/,
  /\b(?:modals?|pop-?ups?|pop ups?|dialogs?)\b/,
  /\baccordions?\b/,
  /\b(?:collapsible|expandable|expand(?:s|ing)? and collapse|collapse)\b/,
  /\btoggl\w+/,
  /\b(?:tabs|tabbed|tab (?:bar|layout|switcher))\b/,
  /\b(?:filter(?:s|able|ing)?|sortable|sorting)\b/,
  /\bsearch (?:bar|box|field|filter)\b|\blive search\b/,
  /\b(?:countdown|timer|stopwatch)\b/,
  /\b(?:count(?:s|ing)? up|animated (?:counters?|numbers?|stats?)|number counters?)\b/,
  /\bcalculator\b|\bestimator\b|\bquote builder\b|\bconfigurator\b/,
  /\bquiz\b|\bsurvey\b|\bpoll\b/,
  /\b(?:forms?|sign-?ups?|newsletter (?:box|signup)|subscribe box|booking|reservations?|checkout|cart|basket|payments?|login|log-?in)\b/,
  /\bvalidat\w+/,
  /\b(?:maps?|google maps)\b/,
  /\b(?:video (?:background|hero|header)|background video|autoplay\w*)\b/,
  /\bsticky\b|\bfixed (?:header|bar|button|sidebar)\b/,
  /\b(?:on scroll|scroll(?:ing)?[- ](?:effects?|trigger\w*|reveal\w*|animat\w*|snap)|infinite scroll|smooth scroll\w*|scroll-?spy|back to top)\b/,
  /\b(?:typing|typewriter|marquee|ticker|ticking|blink\w*|pulse|bounce|shake|glow\w*|flip(?:ping)? cards?|card flip|3d|tilt)\b/,
  /\bmasonry\b/,
  /\b(?:javascript|js|scripts?|jquery|react|alpine)\b/,
  /\b(?:dynamic\w*|real-?time|live (?:feed|data|chat|updates?)|api|fetch(?:es|ing)? (?:from|data)|feed from|instagram feed|twitter feed|rss feed)\b/,
  /\b(?:star ratings?|rating widget|rate (?:us|it)|thumbs up|like buttons?|upvot\w+)\b/,
  /\b(?:charts?|graphs?|diagrams?|progress bars?|skill bars?)\b/,
  /\b(?:dark mode|light mode|theme (?:switch|toggle)\w*)\b/,
  /\b(?:pagination|load more|show more button|read more toggle|lazy load\w*)\b/,
  /\b(?:chat ?(?:bot|widget|box)|whatsapp (?:button|widget)|floating (?:button|widget|cta)|cookie (?:banner|consent))\b/,
  /\b(?:drag(?:gable)?|drop-?down menus?|mega ?menus?|hamburger|off-?canvas|side ?drawer)\b/,
  /\b(?:before[- ]and[- ]after|comparison) slider\b|\bimage comparison\b/,
  /\b(?:zoom\w*|magnif\w+|360)\b/,
  /\b(?:automatic\w*|auto-?(?:rotat|play|scroll|updat|refresh|advanc)\w*|rotat(?:e|es|ing|ion)\b|every \d+ ?(?:seconds?|secs?|s)\b|flash(?:es|ing|y)?\b|blink\w*)/,
  // A switch someone flips; "switch the order" or "switch to the new logo" starts the clause instead.
  /(?<!^)\bswitch(?:er|es)?\b(?! (?:to|the order|places|round|around))|\blight\/dark\b/,
  /\b(?:moving (?:background|banner|text|images?|photos?|logos?|gradient|shapes?|letters?|headline)|moves? (?:on its own|by itself|automatically|around|across))\b/,
  /\b(?:stick(?:s|y)? (?:to|at) the (?:top|bottom|side)|stays? (?:at the top|visible|on screen|fixed))\b/,
  /\b(?:online (?:booking|ordering|orders|payments?|shop|store|appointments?)|book(?:ing)? (?:online|appointments?|a table|tables?)|order online|appointments? online|pay online)\b/,
  /\b(?:google reviews|trustpilot|facebook reviews|yelp reviews|reviews? (?:feed|widget|from google)|social (?:feed|wall)|feed of)\b/,
  /\blet (?:people|visitors|users|customers|clients|guests|them|readers|someone) (?:switch|choose|select|pick|filter|sort|leave|rate|vote|submit|upload|book|order|search|type|enter|click|toggle|drag|send|sign|log|pay|buy|play|watch|calculate|compare|expand|open|download|subscribe|register|apply|request|chat|message)\b/,
  // Behaviour described rather than named: "expand when tapped", "visitors can leave stars",
  // "switch between monthly and yearly", "appear one by one as you scroll".
  /\b(?:tap(?:s|ped|ping)?|when (?:you |users? |visitors? |people |someone |customers? )?(?:click|tap|hover|scroll|press|choose|select|pick|type|enter|swipe|drag)\w*|on (?:tap|press|load|page load)|when (?:the page |it )?loads?)\b/,
  /\b(?:users?|visitors?|customers?|people|guests?|clients?|readers?|someone|they) (?:can|could|should be able to|to be able to|will be able to|may) (?:switch|choose|select|pick|filter|sort|leave|rate|vote|submit|upload|book|order|search|type|enter|click|toggle|drag|send|sign|log|pay|buy|add|play|watch|calculate|compare|see more|expand|open)\b/,
  /\b(?:switch(?:es|ing)? between|one (?:by|after) (?:one|another)|(?:appear|fade|slide|pop|reveal|show)\w* (?:in |up |out )?(?:when|as|on|while|once)\b|comes? into view|in(?:to)? view|(?:expand|open|close|reveal|change|move|grow|zoom|rotate|spin|flip)s? (?:when|on|as) )/,
];

// Design work: the look of a whole area, which the cheaper model gets wrong more often.
const DESIGN = [
  /\b(?:layout|re-?layout|grid|masonry|bento)\b/,
  // "phone" alone is usually the phone number.
  /\b(?:responsive\w*|mobile|on (?:a |the |my )?phones?|phones|tablets?|small screens?|breakpoints?)\b/,
  /\blooks? (?:more |a lot |much |really |very )?(?:modern|professional|premium|elegant|sleek|stylish|beautiful|better|nicer|fresh|clean|polished|luxur\w+|high-end|minimal\w*|bold|striking|eye-catching|appealing|attractive|amazing|stunning|creative|unique|fancy|cool|trendy)\b/,
  /\b(?:more|less) (?:modern|professional|premium|elegant|sleek|stylish|polished|minimal|visual|engaging|appealing|attractive|eye-catching)\b/,
  /\b(?:visual(?:ly)? (?:hierarchy|appeal|design|impact)|whitespace|white space|negative space)\b/,
  /\b(?:glass\w*|neumorph\w*|gradients?|blur\w*|overlap\w*|asymmetric\w*|diagonal|wave(?:s|y)? (?:divider|shape|section)|section dividers?|curved|skew\w*)\b/,
  /\b(?:colou?r (?:scheme|palette)|design system|theme|branding|brand look|style guide|typography)\b/,
  // Not "Head of Design" or "web design services".
  /\b(?:(?:the|its|this|a|new|different|nicer|better|whole) design|design of|designed|styled|styling|in an? (?:[\w,-]+ ){0,3}style|style of)\b/,
  /\b(?:icons?(?:grid|set|row)|illustrat\w+|svg|shapes?|patterns?|textures?|backgrounds? (?:image|pattern|shape))\b/,
];

// A new region of the page.
const SECTION = /\b(?:sections?|blocks?|areas?|banners?|hero|panels?|parts?|segments?|strips?|bands?|rows?|tables?|galler(?:y|ies)|showcase|portfolio|testimonials?|reviews?|faqs?|pricing|team|stats?|statistics|features? list|cta|call to action|footer section|header section|sidebar)\b/;

// Where something goes rather than what's added: "add this photo to the about section".
const LOCATION =
  /\b(?:to|in|into|on|at|under|above|below|inside|within|from|of|near|after|before|beside|next to|between) (?:the|our|my|this|that|each|every|all) (?:[\w'-]+ ){0,3}?(?:sections?|blocks?|areas?|banners?|hero|panels?|parts?|rows?|pages?|sidebar|header|footer|top|bottom|end|start)\b/g;

// Room around things: "add more spacing between the sections".
const SPACING = /^(?:add|give|put|use|make|increase|reduce|decrease|remove|less|more)\b.{0,20}\b(?:spacing|padding|margins?|space|gaps?|breathing room|whitespace|white space)\b/;

// Things too small to be a design job when that's all a clause adds or changes.
const SMALL_OBJECT =
  /\b(?:text|words?|wording|sentences?|lines?|paragraphs?|links?|phone(?: number)?|numbers?|e-?mail(?: address)?|address|prices?|costs?|fees?|dates?|times?|hours|opening hours|days?|titles?|headings?|headlines?|sub-?headings?|sub-?titles?|labels?|typos?|spelling|grammar|names?|captions?|alt(?: text)?|bullets?|bullet points?|list items?|quotes?|emojis?|copyright|year|tagline|slogan|description|intro(?:duction)?|url|address|postcode|zip|currency|button text|button label|cta text|font size|font weight|punctuation|tone|voice|logo|image|photo|picture|icon)\b/;

// A style change of one thing ("make the heading bigger", "change the button colour to blue").
const TWEAK =
  /\b(?:bigger|smaller|larger|wider|narrower|taller|shorter|bold(?:er)?|italic|underlined?|uppercase|lowercase|capitali[sz]ed|centred|centered|left-aligned|right-aligned|blue|red|green|black|white|grey|gray|yellow|orange|purple|pink|navy|gold|darker|lighter|brighter|thicker|thinner|rounded|square|spacing|padding|margin|gap|font|colou?r|size)\b/;

const NEGATION = /\b(?:no|not|don't|dont|do not|without|never|avoid|less|fewer|stop|no more|minus|except)\b(?:\s+\w+){0,3}\s*$/;

const SCOPE = /\b(?:whole|entire|full|complete|every|all (?:the )?(?:sections|pages)|from scratch|new page|each (?:section|page)|site-?wide|throughout|top to bottom|end to end)\b/;

// Splitting before a new verb: "remove the hours and add a booking form" is two requests,
// "interactive buttons and effects" is one.
const ACTION_WORDS =
  "add|insert|include|remove|delete|hide|drop|change|update|edit|fix|correct|rename|replace|swap|move|reorder|rearrange|create|build|design|redesign|make|put|write|rewrite|translate|set|use|turn|show|display|link|embed|implement|integrate|get rid of|take|increase|decrease|reduce|shorten|expand|keep";
const SPLIT = new RegExp(`(?:[.;!?](?:\\s+|$)|\\n+|\\s*(?:,\\s*)?\\b(?:and(?: then| also)?|then|also|plus|after that|as well as)\\s+(?=(?:please\\s+)?(?:${ACTION_WORDS})\\b)|,\\s+(?=(?:${ACTION_WORDS})\\b))`, "i");

const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/;

function normalise(text) {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Quoted words are the page's new wording, not part of the request: "change the heading to
// 'Fresh bread every morning'" isn't about every page. Apostrophes (don't, we're) aren't quotes.
const QUOTED = /(^|[\s:(=])(?:'[^'\n]{1,300}'|"[^"\n]{1,300}")(?=[\s.,;:!?)]|$)/g;

function withoutQuotes(text) {
  return text.replace(QUOTED, "$1quoted text");
}

/** The clauses of a request: one per thing asked for. */
export function clausesOf(instruction) {
  return withoutQuotes(String(instruction ?? "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"'))
    .split(/\n/)
    .map((line) => line.replace(LIST_MARKER, ""))
    .join("\n")
    .split(SPLIT)
    .map((part) => normalise(part ?? "").replace(POLITE, "").trim())
    .filter((part) => /[a-z]/.test(part));
}

/** Words of `patterns` the text has, other than ones negated just before them ("no animations"). */
function matches(text, patterns) {
  const found = [];
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, "g");
    for (const m of text.matchAll(re)) {
      if (NEGATION.test(text.slice(0, m.index))) continue;
      found.push(m[0]);
      break;
    }
  }
  return found;
}

function verbOf(clause) {
  for (const verb of VERBS) if (verb.re.test(clause)) return verb;
  return null;
}

/**
 * One clause's score and why. `sure` means a rule recognised it as small work (a removal, a
 * wording or fact change, a one-property tweak, a move): a request is only small when every
 * clause is, so wording the rules don't know stays "standard", never "small".
 */
export function scoreClause(clause) {
  const verb = verbOf(clause);
  const kind = verb?.kind ?? "other";
  let score = verb?.base ?? 1;
  const why = [kind];

  // "replace the slider with a photo": what comes in is the "with" part.
  let target = clause;
  if (kind === "replace") {
    const at = clause.search(/\b(?:with|by|for)\b/);
    if (at >= 0) target = clause.slice(at);
  }

  if (REMINDER.test(clause)) return { clause, kind: "reminder", score: 0, sure: true, why: ["reminder"] };
  if (kind === "remove") {
    // Taking something out is small whatever it is; "remove X and add Y" was split already.
    return { clause, kind, score: 0, sure: true, why: ["remove"] };
  }
  const newLook = clause.search(REDESIGN_PHRASE);
  if (kind === "redesign" || (newLook >= 0 && !NEGATION.test(clause.slice(0, newLook)))) {
    return { clause, kind: "redesign", score: 4, sure: false, why: ["redesign"] };
  }
  if (CONSTRAINT.test(clause) && !matches(clause, FEATURES).length) return { clause, kind: "constraint", score: 0, sure: true, why: ["constraint"] };

  const features = matches(target, FEATURES);
  const making =
    ["add", "build", "replace", "other"].includes(kind) ||
    (kind === "text" && /^(?:make|turn|use|convert)\b/.test(clause) && !TWEAK.test(target)) ||
    // "change the layout to two columns", "turn the list into cards".
    /\b(?:to|into|as) (?:a |an )?(?:[\w-]+ ){0,2}(?:two-column|three-column|columns?|grid|cards?|tiles?|timeline|side[- ]by[- ]side)\b/.test(target);
  const design = matches(target, making ? [...DESIGN, LAYOUT_NOUN] : DESIGN);
  // The regions this clause adds, not the ones it only names as where things go. After a colon
  // come the facts ("update the prices: Basic £10, Team £50"), not more parts.
  const head = target.split(":")[0];
  const added = head.replace(LOCATION, " ");
  const sections = new Set([...added.matchAll(new RegExp(SECTION.source, "g"))].map((m) => m[0].replace(/s$/, "")));
  // Changing something that exists ("update the team photo", "change the hero image") adds no part.
  const adds = kind !== "text" && sections.size > 0;
  // "replace the old phone number with 0800…": what's replaced says what kind of thing it is.
  const small = SMALL_OBJECT.test(kind === "replace" ? clause : target);
  const tweak = TWEAK.test(target) || SPACING.test(target);
  // Site-wide wording or a site-wide colour is still a small change.
  const scope = SCOPE.test(head) && kind !== "text";
  // "make the hero parallax", "turn the cards into a slider": making a feature, not adjusting one.
  const makes = kind === "text" && /^(?:make|turn|use|convert)\b/.test(clause);

  // "make the heading bigger" and "change the button colour" are one-property tweaks.
  if ((kind === "text" || kind === "add" || kind === "other") && tweak && !features.length && !design.length && !scope && (kind !== "add" || SPACING.test(target))) {
    return { clause, kind: "tweak", score: 0, sure: true, why: ["tweak"] };
  }
  // Wording or facts only.
  if (["text", "add", "replace", "other"].includes(kind) && (small || WORDING_VERB.test(clause)) && !features.length && !design.length && !adds && !scope) {
    return { clause, kind, score: 0, sure: true, why: [kind, "small object"] };
  }
  // "We moved!", "we don't do weddings anymore": context for the change that follows.
  if (kind === "other" && STATEMENT.test(clause) && !features.length && !design.length && !sections.size) {
    return { clause, kind: "statement", score: 0, sure: true, why: ["statement"] };
  }
  // A plain fix or change of an existing thing is smaller than making one.
  const weight = (kind === "text" && !makes) || kind === "move" ? 1 : 2;
  if (features.length) {
    // "make the testimonials rotate": making a behaviour, as much as adding one.
    if (makes) score += 1;
    score += Math.min(4, features.length * weight);
    why.push(`features: ${features.join(", ")}`);
  }
  if (design.length) {
    // Changing the layout of something that exists is design work too ("fix the layout on mobile").
    score += Math.min(kind === "text" ? 3 : 2, design.length * (kind === "text" ? 2 : 1));
    why.push(`design: ${design.join(", ")}`);
  }
  if (kind === "rewrite") {
    // Writing a whole page or section is more than a sentence, but it's words, not design.
    if (sections.size || scope || /\bpages?\b/.test(target)) {
      score += 1;
      why.push("a whole page or section of text");
    }
    return { clause, kind, score, sure: !features.length && !design.length, why };
  }
  if (sections.size && ["add", "build", "replace", "other"].includes(kind)) {
    // Three or more new parts at once ("a FAQ, a pricing table and a team section").
    score += sections.size >= 4 ? 2 : 1;
    why.push(`new section${sections.size >= 4 ? "s" : ""}: ${[...sections].join(", ")}`);
  }
  if (scope) {
    score += 1;
    why.push("whole page");
  }
  // Moving a part around, with nothing else to it.
  const sure = kind === "move" && !features.length && !design.length && !scope;
  return { clause, kind, score, sure, why };
}

/**
 * The size of a request. `hint` is the assistant's own label (small/complex), which wins.
 * Returns { size, score, reasons }.
 */
export function taskSize({ instruction, images = [], hint = null } = {}) {
  if (hint === "small" || hint === "complex") return { size: hint, score: null, reasons: ["the assistant's judgement"] };
  const text = String(instruction ?? "").trim();
  if (!text) return { size: "standard", score: null, reasons: ["no instruction"] };

  const clauses = clausesOf(text).map(scoreClause);
  if (!clauses.length) return { size: "standard", score: null, reasons: ["no instruction"] };
  const hardest = clauses.reduce((a, b) => (b.score > a.score ? b : a));
  let score = hardest.score;
  const reasons = [`hardest part: "${hardest.clause.slice(0, 80)}" (${hardest.why.join("; ")})`];

  // Several real changes in one request add up.
  const real = clauses.filter((c) => c.score >= 1).length;
  if (real > 1) {
    const extra = Math.min(2, real - 1);
    score += extra;
    reasons.push(`${real} changes`);
  }
  if (text.length > 1500) {
    score += 2;
    reasons.push("very long instruction");
  } else if (text.length > 700) {
    score += 1;
    reasons.push("long instruction");
  }
  // Placing a lot of photos at once is layout work (photos by web address already go to Claude
  // in the script, which has to fetch them).
  if (images.length >= 4 && score >= 1) {
    score += 1;
    reasons.push(`${images.length} images to place`);
  }

  let size = score >= COMPLEX_AT ? "complex" : score <= SMALL_UP_TO ? "small" : "standard";
  // Small needs every part recognised as small work; anything else keeps the usual rules.
  const unsure = clauses.find((c) => !c.sure);
  if (size === "small" && unsure) {
    size = "standard";
    reasons.push(`not sure "${unsure.clause.slice(0, 60)}" is small`);
  }
  return { size, score, reasons };
}

/** The line the job log shows for it. */
export function describeTaskSize({ size, reasons }) {
  const who = { small: "the faster model does it", standard: "the usual rules pick the model", complex: "Claude does it" }[size];
  return `Task size: ${size} (${reasons.join("; ")}): ${who}`;
}
