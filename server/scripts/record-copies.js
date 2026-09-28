#!/usr/bin/env node
// Records existing site repos as copies of the template, for repos made before
// Duplicate recorded them (only recorded copies can be managed; see sites.js).
//
//   npm --prefix server run record-copies -- <owner/repo> [<owner/repo> …]
//
// Each repo's owner must have an account here with that GitHub account
// connected: their token is used to look the repo up, and the copy is recorded
// under their account. The repo must be a TwinStack site (site.config.json on
// its default branch), and the owner must be able to push to it.

import { closeDb, connectDb, findUserByGithubLogin, githubTokenOf, recordSiteCopy } from "../src/db.js";
import { config } from "../src/config.js";
import { getAccessToken, githubFetch } from "../src/github.js";
import { isTemplate } from "../src/sites.js";

const names = process.argv.slice(2);
if (!names.length || names.some((name) => !/^[\w.-]+\/[\w.-]+$/.test(name))) {
  console.error("Usage: npm --prefix server run record-copies -- <owner/repo> [<owner/repo> …]");
  process.exit(1);
}

async function record(fullName) {
  if (isTemplate(fullName)) throw new Error("that's the template itself");
  const [owner] = fullName.split("/");
  const account = await findUserByGithubLogin(owner);
  const token = account && githubTokenOf(account);
  if (!token) throw new Error(`no account here has GitHub account "${owner}" connected`);
  // Same shape as a request, so an expired token is refreshed and saved.
  const accessToken = await getAccessToken({ githubAuth: token, user: { id: account._id.toHexString() } });

  const res = await githubFetch(`/repos/${fullName}`, accessToken);
  if (res.status === 404) throw new Error(`not found, or ${owner} can't see it`);
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const info = await res.json();
  // Again on GitHub's canonical name, in case the one given was an old name that redirects.
  if (isTemplate(info.full_name)) throw new Error("that's the template itself");
  if (!info.permissions?.push) throw new Error(`${owner} can't push to it`);
  const marker = await githubFetch(
    `/repos/${info.full_name}/contents/site.config.json?ref=${encodeURIComponent(info.default_branch)}`,
    accessToken,
  );
  if (marker.status === 404) throw new Error(`no site.config.json on ${info.default_branch}, so it isn't a TwinStack site`);

  await recordSiteCopy({
    userId: account._id.toHexString(),
    repo: { id: info.id, fullName: info.full_name, name: info.name },
    source: config.siteTemplate,
  });
  return info.full_name;
}

await connectDb();
let failed = 0;
for (const name of names) {
  try {
    console.log(`recorded  ${await record(name)}`);
  } catch (err) {
    failed++;
    console.error(`skipped   ${name}: ${err.message}`);
  }
}
await closeDb();
process.exit(failed ? 1 : 0);
