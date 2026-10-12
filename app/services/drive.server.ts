// Google Drive (spec "Google Drive"): one folder tree per fundraiser in the
// "Fundraising" shared drive, created by a service account that is a Content
// manager there. Folders are always found by their stored ID, never by name,
// so nothing is ever created twice. No folder is ever shared.
//
//   Fundraising/                    (the shared drive: DRIVE_SHARED_DRIVE_ID)
//     {Organization}/               organizations.drive_folder_id
//       {Team}/                     teams.drive_folder_id
//         _Product & Artwork/       teams.drive_artwork_folder_id (reused every season)
//         {Year Season}/            fundraisers.drive_folder_id
//           Organizer Assets/       fundraisers.drive_assets_folder_id
//           Internal/               fundraisers.drive_internal_folder_id
//     _Backups/                     app_settings "drive_backups_folder_id"

import { createSign } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";
import { UserError } from "../lib/errors";
import { alertError } from "./alerts.server";
import { writeAudit } from "./audit.server";

export interface DriveClient {
  /** The shared drive's ID; its root holds the organization folders. */
  rootId: string;
  createFolder(name: string, parentId: string): Promise<{ id: string }>;
  /** Uploads a file; returns its ID. */
  uploadFile(name: string, parentId: string, mimeType: string, content: string): Promise<{ id: string }>;
}

export const ARTWORK_FOLDER = "_Product & Artwork";
export const ASSETS_FOLDER = "Organizer Assets";
export const INTERNAL_FOLDER = "Internal";
export const BACKUPS_FOLDER = "_Backups";
const BACKUPS_SETTING = "drive_backups_folder_id";

export function folderUrl(id: string): string {
  return `https://drive.google.com/drive/folders/${id}`;
}

// ---------------------------------------------------------- real client

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/** Null when Drive isn't configured on this service (the UI says so). */
export function createDriveClient(env: NodeJS.ProcessEnv = process.env): DriveClient | null {
  const json = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const rootId = env.DRIVE_SHARED_DRIVE_ID?.trim();
  if (!json || !rootId) return null;
  let key: ServiceAccountKey;
  try {
    key = JSON.parse(json) as ServiceAccountKey;
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON isn't valid JSON; paste the whole key file.");
  }

  let token: { value: string; expires: number } | null = null;
  async function accessToken(): Promise<string> {
    if (token && token.expires > Date.now() + 60_000) return token.value;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/drive",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key).toString("base64url");
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
    });
    if (!res.ok) throw new Error(`Google sign-in failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
    return token.value;
  }

  async function google(url: string, init: RequestInit): Promise<{ id: string }> {
    const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${await accessToken()}` } });
    if (!res.ok) throw new Error(`Google Drive ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as { id: string };
  }

  return {
    rootId,
    createFolder(name, parentId) {
      return google("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
      });
    },
    uploadFile(name, parentId, mimeType, content) {
      const boundary = `mambe${Date.now()}`;
      const body =
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parentId] })}\r\n` +
        `--${boundary}\r\ncontent-type: ${mimeType}\r\n\r\n${content}\r\n--${boundary}--`;
      return google("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id", {
        method: "POST",
        headers: { "content-type": `multipart/related; boundary=${boundary}` },
        body,
      });
    },
  };
}

// ---------------------------------------------------------- folder tree

const SEASONS = ["Fall", "Winter", "Spring", "Summer"];

function seasonForMonth(month: number): string {
  if (month >= 8 && month <= 11) return "Fall";
  if (month === 12 || month <= 2) return "Winter";
  if (month <= 5) return "Spring";
  return "Summer";
}

/** "{Year Season}", e.g. "2026 Fall": from the season label, else the start date, else today. */
export function seasonFolderName(f: { seasonLabel: string | null; startDate: Date | null; timezone: string }, now = new Date()): string {
  const label = f.seasonLabel ?? "";
  const season = SEASONS.find((s) => new RegExp(`\\b${s}\\b`, "i").test(label));
  const year = label.match(/\b(20\d\d)\b/)?.[1];
  if (season && year) return `${year} ${season}`;
  const d = f.startDate ? DateTime.fromJSDate(f.startDate, { zone: "utc" }) : DateTime.fromJSDate(now).setZone(f.timezone);
  return `${d.year} ${season ?? seasonForMonth(d.month)}`;
}

export interface DriveResult {
  ok: boolean;
  error?: string;
  folders?: { organization: string; team: string; artwork: string; season: string; assets: string; internal: string };
}

/**
 * Create whatever part of the tree is missing for this fundraiser. Each folder
 * ID is saved as soon as it exists, so a retry after a failure carries on
 * where it stopped. Never throws: a failure is recorded on the fundraiser
 * (Retry button, work-queue item) and blocks nothing else.
 */
export async function createDriveFolders(db: PrismaClient, drive: DriveClient, fundraiserId: number, actor: string, now = new Date()): Promise<DriveResult> {
  const f = await db.fundraiser.findUniqueOrThrow({ where: { id: fundraiserId }, include: { team: { include: { organization: true } } } });
  try {
    const org = f.team.organization;
    let orgId = org.driveFolderId;
    if (!orgId) {
      orgId = (await drive.createFolder(org.name, drive.rootId)).id;
      await db.organization.update({ where: { id: org.id }, data: { driveFolderId: orgId } });
    }

    const team = f.team;
    let teamId = team.driveFolderId;
    if (!teamId) {
      teamId = (await drive.createFolder(team.name, orgId)).id;
      await db.team.update({ where: { id: team.id }, data: { driveFolderId: teamId } });
    }
    let artworkId = team.driveArtworkFolderId;
    if (!artworkId) {
      artworkId = (await drive.createFolder(ARTWORK_FOLDER, teamId)).id;
      await db.team.update({ where: { id: team.id }, data: { driveArtworkFolderId: artworkId } });
    }

    let seasonId = f.driveFolderId;
    if (!seasonId) {
      // Two fundraisers for one team in the same season get distinct names.
      let name = seasonFolderName(f, now);
      const sameSeason = await db.fundraiser.findMany({ where: { teamId: team.id, id: { not: f.id }, driveFolderId: { not: null } } });
      if (sameSeason.some((o) => seasonFolderName(o, now) === name)) name = `${name} (${f.publicCode})`;
      seasonId = (await drive.createFolder(name, teamId)).id;
      await db.fundraiser.update({ where: { id: f.id }, data: { driveFolderId: seasonId } });
    }
    let assetsId = f.driveAssetsFolderId;
    if (!assetsId) {
      assetsId = (await drive.createFolder(ASSETS_FOLDER, seasonId)).id;
      await db.fundraiser.update({ where: { id: f.id }, data: { driveAssetsFolderId: assetsId } });
    }
    let internalId = f.driveInternalFolderId;
    if (!internalId) {
      internalId = (await drive.createFolder(INTERNAL_FOLDER, seasonId)).id;
      await db.fundraiser.update({ where: { id: f.id }, data: { driveInternalFolderId: internalId } });
    }

    const folders = { organization: orgId, team: teamId, artwork: artworkId, season: seasonId, assets: assetsId, internal: internalId };
    const ticked = !!f.driveFoldersCreatedAt;
    await db.$transaction(async (tx) => {
      await tx.fundraiser.update({
        where: { id: f.id },
        data: {
          driveError: null,
          driveErrorAt: null,
          ...(ticked ? {} : { driveFoldersCreatedAt: now, driveFoldersCreatedBy: actor }),
        },
      });
      await writeAudit(tx, { entity: "fundraiser", entityId: f.id, action: "drive:created", after: folders, actor });
      if (!ticked) {
        await writeAudit(tx, {
          entity: "fundraiser",
          entityId: f.id,
          action: "checklist:done",
          before: { item: "Drive folders created", at: null, by: null },
          after: { item: "Drive folders created", at: now, by: actor },
          actor,
        });
      }
    });
    return { ok: true, folders };
  } catch (error) {
    const message = String((error as Error)?.message ?? error).slice(0, 500);
    await db.fundraiser.update({ where: { id: f.id }, data: { driveError: message, driveErrorAt: now } });
    await writeAudit(db, { entity: "fundraiser", entityId: f.id, action: "drive:failed", after: { error: message }, actor });
    alertError(error, `Drive folders failed for ${f.publicCode}`);
    return { ok: false, error: message };
  }
}

/** For the fundraiser page: the stored folders as links. */
export async function driveLinks(db: PrismaClient, fundraiserId: number) {
  const f = await db.fundraiser.findUniqueOrThrow({ where: { id: fundraiserId }, include: { team: { include: { organization: true } } } });
  const link = (label: string, id: string | null) => (id ? { label, url: folderUrl(id) } : null);
  return {
    created: !!(f.driveFolderId && f.driveAssetsFolderId && f.driveInternalFolderId),
    error: f.driveError,
    errorAt: f.driveErrorAt?.toISOString() ?? null,
    links: [
      link("Season folder", f.driveFolderId),
      link(ASSETS_FOLDER, f.driveAssetsFolderId),
      link(INTERNAL_FOLDER, f.driveInternalFolderId),
      link(ARTWORK_FOLDER, f.team.driveArtworkFolderId),
      link(`${f.team.name} (team)`, f.team.driveFolderId),
      link(`${f.team.organization.name} (organization)`, f.team.organization.driveFolderId),
    ].filter((x): x is { label: string; url: string } => !!x),
  };
}

export function driveOrThrow(env: NodeJS.ProcessEnv = process.env): DriveClient {
  const drive = createDriveClient(env);
  if (!drive) throw new UserError("Google Drive isn't set up on this service yet (GOOGLE_SERVICE_ACCOUNT_JSON and DRIVE_SHARED_DRIVE_ID in Render).");
  return drive;
}

// ---------------------------------------------------------- backups

/** Fundraising/_Backups/, created once and found by its stored ID afterwards. */
export async function backupsFolderId(db: PrismaClient, drive: DriveClient): Promise<string> {
  const stored = await db.appSetting.findUnique({ where: { key: BACKUPS_SETTING } });
  if (stored) return stored.value;
  const { id } = await drive.createFolder(BACKUPS_FOLDER, drive.rootId);
  await db.appSetting.create({ data: { key: BACKUPS_SETTING, value: id } });
  return id;
}
