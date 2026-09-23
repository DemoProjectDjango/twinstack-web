import { config } from "./config.js";
import { setSession } from "./session.js";

/** Thrown when the stored GitHub token can't be used or refreshed; the user must sign in again. */
export class ReauthRequiredError extends Error {}

const TOKEN_URL = "https://github.com/login/oauth/access_token";
const REFRESH_MARGIN_MS = 60 * 1000;
const MAX_REPO_PAGES = 10; // 100 per page → up to 1,000 repositories

async function requestToken(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.github.clientId,
      client_secret: config.github.clientSecret,
      ...params,
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    const err = new Error(`GitHub token request failed: ${data.error ?? res.status}`);
    err.details = data;
    throw err;
  }
  // `expires_in` / `refresh_token` are only present when the OAuth App has
  // "Expire user access tokens" enabled.
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
    scopes: (data.scope ?? "").split(",").filter(Boolean),
  };
}

export function exchangeCode(code) {
  return requestToken({ code, redirect_uri: config.github.callbackUrl });
}

/**
 * Returns a usable access token for the current session, refreshing it (and
 * re-issuing the session cookie) when it is about to expire.
 */
export async function getAccessToken(req, res) {
  const { github } = req.session;
  if (!github.expiresAt || github.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return github.accessToken;
  }
  if (!github.refreshToken) throw new ReauthRequiredError("Access token expired");

  let refreshed;
  try {
    refreshed = await requestToken({
      grant_type: "refresh_token",
      refresh_token: github.refreshToken,
    });
  } catch (err) {
    throw new ReauthRequiredError(err.message);
  }
  // Keep the known scopes if the refresh response doesn't list them.
  if (!refreshed.scopes.length) refreshed.scopes = github.scopes ?? [];
  req.session = { ...req.session, github: refreshed };
  await setSession(res, req.session);
  return refreshed.accessToken;
}

export async function githubFetch(pathOrUrl, accessToken, { method = "GET", body } = {}) {
  const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `https://api.github.com${pathOrUrl}`;
  const res = await fetch(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "twinstack-web",
    },
  });
  if (res.status === 401) throw new ReauthRequiredError("GitHub rejected the access token");
  return res;
}

function nextPageUrl(linkHeader) {
  return linkHeader?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
}

/** Every repository the user can access: owned, collaborator, and via org membership. */
export async function listRepos(accessToken) {
  const params = new URLSearchParams({
    visibility: "all",
    affiliation: "owner,collaborator,organization_member",
    sort: "updated",
    per_page: "100",
  });
  let url = `/user/repos?${params}`;
  const repos = [];

  for (let page = 0; url && page < MAX_REPO_PAGES; page++) {
    const res = await githubFetch(url, accessToken);
    if (!res.ok) throw new Error(`GitHub /user/repos failed with ${res.status}`);
    repos.push(...(await res.json()));
    url = nextPageUrl(res.headers.get("link"));
  }

  return repos.map((repo) => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    owner: repo.owner.login,
    private: repo.private,
    fork: repo.fork,
    archived: repo.archived,
    description: repo.description,
    htmlUrl: repo.html_url,
    language: repo.language,
    stars: repo.stargazers_count,
    updatedAt: repo.updated_at,
    permission: repo.permissions?.admin ? "admin" : repo.permissions?.push ? "write" : "read",
  }));
}
