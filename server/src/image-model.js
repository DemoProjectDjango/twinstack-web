import { IMAGE_MODELS } from "./ai-providers.js";
import { config } from "./config.js";
import { listedPrices } from "./credits.js";
import { getAppSetting, getSiteModels, setAppSetting, setSiteModel } from "./db.js";
import { imagesAvailable, pictureCredits } from "./images.js";

// The OpenAI image model pictures are made with ("Ask Claude"'s create_image, images.js). An admin
// picks it on /admin/models, from IMAGE_MODELS; until one does, IMAGE_MODEL in the server's .env
// decides (config.imageModel, gpt-image-2 when unset). Each site may choose its own on its AI model
// screen (siteCopies.imageModel), and follows the admin's until it does. All of them need
// OPENAI_API_KEY. The admin's choice is kept in memory (one API process) and in appSettings, read
// once at startup, like the fast model's (fast-model.js).

const SETTING = "imageModel";

let chosen = null;
let chosenAt = null;
let chosenBy = null;

export async function loadImageModelChoice() {
  const doc = await getAppSetting(SETTING);
  chosen = typeof doc?.value === "string" ? doc.value : null;
  chosenAt = doc?.updatedAt ?? null;
  chosenBy = doc?.updatedBy ?? null;
}

/** A model that may be chosen: a listed one, or the one IMAGE_MODEL names. */
const isOffered = (model) => typeof model === "string" && (IMAGE_MODELS.some((m) => m.id === model) || model === config.imageModel);

/** The admin's choice, else IMAGE_MODEL's. */
const wanted = () => (isOffered(chosen) ? chosen : config.imageModel);

/** The image model to use now, or null when pictures can't be made (no OpenAI key). */
export function currentImageModel() {
  return imagesAvailable() ? wanted() : null;
}

const nameOf = (model) => IMAGE_MODELS.find((m) => m.id === model)?.name ?? model;

/** The models to choose from, each with its prices and what a medium landscape picture costs at most. */
function models() {
  const listed = IMAGE_MODELS.some((m) => m.id === config.imageModel)
    ? IMAGE_MODELS
    : [...IMAGE_MODELS, { id: config.imageModel, name: config.imageModel, description: "Set by IMAGE_MODEL on the server." }];
  return listed.map((m) => ({ ...m, price: listedPrices(m.id), pictureCredits: pictureCredits(m.id) }));
}

/** What /admin/models shows for pictures. */
export function imageModelView() {
  return {
    choice: wanted(),
    source: isOffered(chosen) ? "admin" : "env",
    active: currentImageModel(),
    available: imagesAvailable(),
    updatedAt: chosenAt,
    updatedBy: chosenBy,
    models: models(),
  };
}

/** A choice setImageModel or chooseSiteImageModel refuses, with a message to show. */
export class ImageModelError extends Error {}

function checkChoice(model) {
  if (!isOffered(model)) throw new ImageModelError("Choose one of the listed image models.");
  if (!imagesAvailable()) throw new ImageModelError("Set OPENAI_API_KEY on the server to make pictures.");
}

/** Saves the admin's choice. Throws ImageModelError. */
export async function setImageModel(model, adminEmail) {
  checkChoice(model);
  await setAppSetting(SETTING, model, adminEmail);
  chosen = model;
  chosenAt = new Date();
  chosenBy = adminEmail;
}

/* --------------------------------------------------------------- per site */

/** The image model for a site's pictures now (or null): its own choice when still offered, else the admin's. */
export async function imageModelForSite(siteId) {
  if (!imagesAvailable()) return null;
  const stored = await getSiteModels(siteId).then(
    (choices) => choices.imageModel,
    (err) => {
      console.error(`Couldn't read site ${siteId}'s image model:`, err.message);
      return null;
    },
  );
  return isOffered(stored) ? stored : wanted();
}

/** What a site's AI model screen shows for pictures: its choice ("default" follows the admin's), what that is, and the models. */
export async function siteImageModelView(siteId) {
  const stored = (await getSiteModels(siteId)).imageModel;
  const active = imagesAvailable() ? (isOffered(stored) ? stored : wanted()) : null;
  return {
    choice: stored ?? "default",
    // A chosen model that's no longer offered follows the admin's.
    unavailable: stored !== null && !isOffered(stored),
    available: imagesAvailable(),
    default: { id: wanted(), name: nameOf(wanted()) },
    active: active && { id: active, name: nameOf(active) },
    models: models(),
  };
}

/** Saves a site's choice: "default" (the admin's) or an offered model. Throws ImageModelError. */
export async function chooseSiteImageModel(siteId, model, userId) {
  if (model !== "default") checkChoice(model);
  if (!(await setSiteModel(siteId, "imageModel", model === "default" ? null : model, userId))) {
    throw new ImageModelError("This site's choice can't be saved: open the site again and retry.");
  }
}
