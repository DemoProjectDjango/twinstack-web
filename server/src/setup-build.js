import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { beginSpend } from "./credits.js";
import { FIRST_DESIGN_EFFORT, FIRST_HOME_REVIEWS, REVIEW_MODEL, firstDesignModel } from "./first-design.js";
import { imageModelForSite } from "./image-model.js";
import { generateImage, imagesAvailable } from "./images.js";
import { getNavigation, saveNavigation, setPageMenu } from "./navigation.js";
import { createHomepage, createPageAt, getOverview } from "./site-files.js";
import { saveBrand } from "./brand.js";
import { acquire, workspaceDir } from "./workspace.js";

// A new site's build from its setup answers (site-setup.js's buildPlan), run by the server as one
// `site-build` job instead of by the assistant: the assistant re-sent its whole conversation for
// every step it coordinated (about 2,900 credits a setup), while here Claude is only paid for writing.
// - prepareBuild runs when the answers are saved, before the job (it takes the workspace lock for
//   each change, which the job would hold): it makes the homepage and the chosen pages' files, puts
//   each page in the menu, and saves the plan with their files to BUILD_PLAN.
// - buildSteps is the job: one picture for a photo-led business without photos (images.js, charged
//   like the assistant's), the homepage (Opus at medium effort, then one screenshot review by
//   REVIEW_MODEL), the header and footer (Sonnet), then each chosen page (the site's usual models, the
//   cheaper one first: they follow the homepage's design). Every step is the site's own edit-page.js.
// Each step logs a "▸ " line, which the editor shows as the build's progress (lib/job-labels.ts).

export const BUILD_PLAN = ".git/twinstack-setup-build.json";
const GENERATED_DIR = "assets/img/generated";
const MINUTE = 60 * 1000;
// Pages whose place is the footer's legal links rather than the header's menu.
const FOOTER_PAGE = /privacy|terms|cookie|legal|imprint|disclaimer/i;

/**
 * Makes the files the build writes and saves the plan. A page that can't be made is left out of the
 * plan (and logged); the build still runs for the rest. Resolves to the plan as saved.
 */
export async function prepareBuild(key, plan) {
  const overview = await getOverview(key);
  const at = (address) => overview.collections.flatMap((c) => c.pages).find((p) => p.address === address)?.file;
  const saved = { ...plan, home: null, pages: [] };
  if (plan.home) {
    try {
      saved.home = { ...plan.home, file: at("/") ?? (await createHomepage(key, { title: plan.home.title })).file };
    } catch (err) {
      console.error(`Couldn't make the homepage of ${key} for its build:`, err.message);
    }
  }
  for (const page of plan.pages) {
    try {
      const file = at(page.address) ?? (await createPageAt(key, { url: page.address, title: page.title })).file;
      if (overview.features.pageMenus && !plan.navigation) await setPageMenu(key, file, FOOTER_PAGE.test(page.address) ? "footer" : "header").catch(() => {});
      saved.pages.push({ ...page, file });
    } catch (err) {
      console.error(`Couldn't make ${page.address} in ${key} for its build:`, err.message);
    }
  }
  if (plan.navigation) await applyNavigation(key, plan.navigation).catch((err) => console.error(`Couldn't set up the header and footer of ${key}:`, err.message));
  await fs.writeFile(path.join(workspaceDir(key), BUILD_PLAN), JSON.stringify(saved));
  return saved;
}

/**
 * The header and footer the owner chose (buildPlan's `navigation`), in content/data/navigation.json:
 * the header's button (or none), whether it stays at the top, what the footer shows and its
 * call-to-action strip. The template's RSS feed link goes too: a new site has no posts to follow.
 * The look settings are written only to copies whose header and footer read them.
 */
async function applyNavigation(key, wanted) {
  const { navigation, version, supportsAppearance } = await getNavigation(key);
  const next = {
    ...navigation,
    // The menu and the footer's columns as the owner set them; the template's own (less its RSS link) otherwise.
    header: { ...navigation.header, ...(wanted.items && { items: wanted.items }), cta: wanted.button },
    footer: wanted.columns ?? navigation.footer.map((column) => ({ ...column, links: column.links.filter((link) => link.url !== "/rss.xml") })),
  };
  if (supportsAppearance) {
    const { header, footer } = navigation.appearance;
    next.appearance = {
      ...navigation.appearance,
      header: { ...header, ...wanted.header, sticky: wanted.sticky, shrink: wanted.shrink !== false, transparent: wanted.transparent === true },
      footer: {
        ...footer,
        ...wanted.footerLook,
        showTagline: wanted.footer.showTagline,
        showContact: wanted.footer.showContact,
        showSocial: wanted.footer.showSocial,
        cta: wanted.footer.cta,
        copyright: wanted.copyright ?? footer.copyright,
      },
    };
  } else {
    delete next.appearance;
  }
  await saveNavigation(key, next, version);
  if (wanted.accent) await applyAccent(key, wanted.accent, wanted.initial, wanted.logo, wanted.iconGiven === true);
}

const MAIN_CSS = "styles/main.css";
const MARK_FILE = "assets/img/brand/mark.svg";

/** `hex` mixed with white by `amount` (0–1), for the mark's lighter gradient stop. */
function lighter(hex, amount) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `#${channels.map((c) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, "0")).join("")}`;
}

const escapeXml = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * The owner's accent colour as the site's "brand" (styles/main.css → @theme --color-brand, which the
 * header, footer and pages use), and a square mark in it with the business's `initial`, set as the
 * logo mark beside the name (and so the favicon) in place of the template's generic one. With
 * `logo` "name" the name shows alone: the mark is still made, as the browser-tab icon, and the
 * header and footer's logoMark is emptied (the template's partials show it only when it's set).
 */
async function applyAccent(key, hex, initial, logo = "mark", iconGiven = false) {
  const dir = workspaceDir(key);
  const release = acquire(key, "setting the site's colour");
  try {
    const css = await fs.readFile(path.join(dir, MAIN_CSS), "utf8").catch(() => null);
    if (css && /--color-brand:\s*[^;]+;/.test(css)) await fs.writeFile(path.join(dir, MAIN_CSS), css.replace(/--color-brand:\s*[^;]+;/, `--color-brand: ${hex};`));
    if (initial) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${lighter(hex, 0.3)}"/>
      <stop offset="1" stop-color="${hex}"/>
    </linearGradient>
  </defs>
  <rect width="32" height="32" rx="9" fill="url(#g)"/>
  <text x="16" y="21.6" text-anchor="middle" font-family="Geist, 'Segoe UI', Arial, sans-serif" font-size="16" font-weight="700" fill="#ffffff">${escapeXml(initial)}</text>
</svg>
`;
      await fs.mkdir(path.join(dir, path.dirname(MARK_FILE)), { recursive: true });
      await fs.writeFile(path.join(dir, MARK_FILE), svg);
    }
  } finally {
    release();
  }
  if (!initial) return;
  // The mark is the tab icon too, unless the owner gave one (their own, or their logo).
  await saveBrand(key, { logoMark: `/${MARK_FILE}`, ...(!iconGiven && { favicon: `/${MARK_FILE}` }) });
  if (logo === "name") await emptyLogoMark(key);
}

/** site.config.json → brand.logoMark set to "", which brand.js never writes (older templates would show a broken image). */
async function emptyLogoMark(key) {
  const file = path.join(workspaceDir(key), "site.config.json");
  const release = acquire(key, "showing the site's name alone");
  try {
    const text = await fs.readFile(file, "utf8");
    const next = text.replace(/("logoMark"\s*:\s*)"[^"]*"/, '$1""');
    if (next !== text) await fs.writeFile(file, next);
  } finally {
    release();
  }
}

/** Whether the site has a build that hasn't finished (it stopped, or the server restarted mid-way). */
export async function pendingBuild(key) {
  const plan = JSON.parse(await fs.readFile(path.join(workspaceDir(key), BUILD_PLAN), "utf8").catch(() => "null"));
  return Boolean(plan && (plan.picture || plan.home || plan.chrome || plan.pages?.length));
}

/** The job's env without the cheaper model: first designs are never written by it. */
function withoutFastModel(env) {
  const { TWINSTACK_FAST_MODEL, TWINSTACK_TASK_SIZE, ...rest } = env;
  return rest;
}

const writer = (args, env, display) => ({ file: process.execPath, args: ["scripts/edit-page.js", ...args], display, timeoutMs: 30 * MINUTE, env });

/**
 * The site-build job's steps. `env` is the job's (the account's model and key or proxy token, and the
 * site's cheaper model on credits); `userId`, `siteId` and `charged` pay for the picture.
 */
export function buildSteps({ env, userId, siteId, charged }) {
  return [
    {
      display: "Building the site from its setup answers",
      run: async ({ log, exec, cwd }) => {
        const file = path.join(cwd, BUILD_PLAN);
        const plan = JSON.parse(await fs.readFile(file, "utf8").catch(() => "null"));
        if (!plan) throw new Error("There's no build plan: save the setup answers again.");
        const total = (plan.picture ? 1 : 0) + (plan.home ? 1 : 0) + (plan.chrome ? 1 : 0) + plan.pages.length;
        let n = 0;
        const step = (words) => log(`▸ ${++n}/${total} ${words}`);
        const failed = [];
        // Each finished step comes off the plan at once, so a build that stops (an error, or the
        // server restarting, which ends every job) carries on from there when it's run again.
        const save = () => fs.writeFile(file, JSON.stringify(plan));
        if (plan.resumed) log("  Carrying on from where the last build stopped.");
        plan.resumed = true;

        const images = [...(plan.home?.images ?? [])];
        if (plan.picture) {
          step("Making a picture for your homepage");
          try {
            if (!imagesAvailable()) throw new Error("pictures can't be made on this server");
            const runId = randomUUID();
            const image = await generateImage({
              model: await imageModelForSite(siteId),
              prompt: plan.picture,
              shape: "landscape",
              quality: "medium",
              beginSpend: () => beginSpend({ userId, siteId, runId, kind: "setup", command: "site-build", charged }),
            });
            const name = `homepage-${Date.now().toString(36)}.${image.extension}`;
            await fs.mkdir(path.join(cwd, GENERATED_DIR), { recursive: true });
            await fs.writeFile(path.join(cwd, GENERATED_DIR, name), image.bytes);
            images.unshift(`${GENERATED_DIR}/${name}`);
            log(`  Saved ${GENERATED_DIR}/${name}`);
          } catch (err) {
            log(`  ! The picture couldn't be made (${err.message}); the homepage is designed without it.`);
          }
          // Made (or given up on) once: a later run uses the picture rather than paying for another.
          plan.picture = null;
          if (plan.home) plan.home.images = images;
          await save();
        }

        if (plan.home) {
          step("Designing your homepage");
          const homeEnv = {
            ...withoutFastModel(env),
            TWINSTACK_MODEL: firstDesignModel(env.TWINSTACK_MODEL, "homepage"),
            TWINSTACK_EFFORT: FIRST_DESIGN_EFFORT,
            TWINSTACK_DESIGN_REVIEW: String(FIRST_HOME_REVIEWS),
            TWINSTACK_REVIEW_MODEL: REVIEW_MODEL,
          };
          const args = [plan.home.file, plan.home.instruction, ...images.map((image) => `--image=${image}`)];
          if ((await exec(writer(args, homeEnv, `node scripts/edit-page.js ${plan.home.file} (the homepage)`))).code !== 0) {
            await save();
            throw new Error("The homepage couldn't be designed, so the build stopped. Press Try again to carry on.");
          }
          plan.home = null;
          await save();
        }

        if (plan.chrome) {
          step("Designing the header and footer");
          const chromeEnv = { ...withoutFastModel(env), TWINSTACK_MODEL: firstDesignModel(env.TWINSTACK_MODEL, "header and footer"), TWINSTACK_EFFORT: FIRST_DESIGN_EFFORT };
          if ((await exec(writer(["--chrome", plan.chrome], chromeEnv, "node scripts/edit-page.js --chrome (the header and footer)"))).code !== 0) failed.push("the header and footer");
          else {
            plan.chrome = null;
            await save();
          }
        }

        for (const page of [...plan.pages]) {
          step(`Writing the ${page.title} page`);
          if ((await exec(writer([page.file, page.instruction], env, `node scripts/edit-page.js ${page.file}`))).code !== 0) failed.push(`the ${page.title} page`);
          else {
            plan.pages = plan.pages.filter((p) => p !== page);
            await save();
          }
        }

        // What didn't work stays in the plan, for Try again; a finished build leaves none.
        if (failed.length) log(`! Not finished: ${failed.join(", ")}. Press Try again, or ask the AI to do ${failed.length === 1 ? "it" : "them"}.`);
        else await fs.rm(file, { force: true });
        log("▸ Done");
      },
    },
  ];
}
