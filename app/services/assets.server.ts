// Fundraiser assets: links to flyers, email copy and social images (no
// uploads). Organizers will only ever see current, organizer-visible ones.

import type { PrismaClient } from "@prisma/client";
import { UserError } from "../lib/errors";
import { writeAudit } from "./audit.server";

import { ASSET_KINDS, ASSET_VISIBILITIES } from "../lib/assets";

export { ASSET_KINDS, ASSET_VISIBILITIES };

export interface AssetInput {
  title: string;
  kind: string;
  url: string;
  visibility: string;
}

function validate(input: AssetInput): AssetInput {
  const title = input.title.trim();
  if (!title) throw new UserError("Give the asset a title.");
  if (!(ASSET_KINDS as readonly string[]).includes(input.kind)) throw new UserError("Choose a kind.");
  if (!(ASSET_VISIBILITIES as readonly string[]).includes(input.visibility)) throw new UserError("Choose who can see it.");
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    throw new UserError("Paste a full link, starting with https://");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UserError("The link must start with https://");
  return { title, kind: input.kind, url: url.toString(), visibility: input.visibility };
}

export async function addAsset(db: PrismaClient, fundraiserId: number, input: AssetInput, actor: string) {
  const data = validate(input);
  return db.$transaction(async (tx) => {
    const asset = await tx.asset.create({ data: { fundraiserId, ...data, createdBy: actor } });
    await writeAudit(tx, { entity: "fundraiser", entityId: fundraiserId, action: "asset:add", after: { assetId: asset.id, ...data }, actor });
    return asset;
  });
}

/** Adds the new asset and marks the old one not current, pointing at its replacement. */
export async function replaceAsset(db: PrismaClient, oldAssetId: number, input: AssetInput, actor: string) {
  const data = validate(input);
  const old = await db.asset.findUniqueOrThrow({ where: { id: oldAssetId } });
  if (!old.isCurrent) throw new UserError("That asset was already replaced.");
  return db.$transaction(async (tx) => {
    const asset = await tx.asset.create({ data: { fundraiserId: old.fundraiserId, ...data, createdBy: actor } });
    await tx.asset.update({ where: { id: old.id }, data: { isCurrent: false, replacedById: asset.id, replacedAt: new Date() } });
    await writeAudit(tx, {
      entity: "fundraiser",
      entityId: old.fundraiserId,
      action: "asset:replace",
      before: { assetId: old.id, title: old.title, url: old.url },
      after: { assetId: asset.id, ...data },
      actor,
    });
    return asset;
  });
}

/** What an organizer may see (the portal uses this in session 4). */
export function organizerVisibleAssets(db: PrismaClient, fundraiserId: number) {
  return db.asset.findMany({ where: { fundraiserId, visibility: "organizer", isCurrent: true }, orderBy: { createdAt: "asc" } });
}
