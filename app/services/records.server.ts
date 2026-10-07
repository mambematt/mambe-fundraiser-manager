// Organizations, teams and organizers: plain create and edit, audited.

import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "./audit.server";
import { UserError } from "../lib/errors";

import { ORGANIZATION_TYPES } from "../lib/organizations";

export { ORGANIZATION_TYPES };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value: FormDataEntryValue | string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function required(value: FormDataEntryValue | string | null | undefined, label: string): string {
  const text = clean(value);
  if (!text) throw new UserError(`${label} is required.`);
  return text;
}

// ------------------------------------------------------------ organizations

export function organizationInput(form: FormData) {
  const type = clean(form.get("type")) ?? "school";
  if (!(ORGANIZATION_TYPES as readonly string[]).includes(type)) throw new UserError("Choose a valid type.");
  return {
    name: required(form.get("name"), "Name"),
    type,
    city: clean(form.get("city")),
    state: clean(form.get("state"))?.toUpperCase() ?? null,
    website: clean(form.get("website")),
    notes: clean(form.get("notes")),
  };
}

export async function saveOrganization(
  db: PrismaClient,
  id: number | null,
  input: ReturnType<typeof organizationInput>,
  actor: string,
) {
  if (id === null) {
    const created = await db.organization.create({ data: input });
    await writeAudit(db, { entity: "organization", entityId: created.id, action: "create", after: input, actor });
    return created;
  }
  const before = await db.organization.findUniqueOrThrow({ where: { id } });
  const updated = await db.organization.update({ where: { id }, data: input });
  await writeAudit(db, {
    entity: "organization",
    entityId: id,
    action: "edit",
    before: { name: before.name, type: before.type, city: before.city, state: before.state, website: before.website, notes: before.notes },
    after: input,
    actor,
  });
  return updated;
}

// -------------------------------------------------------------------- teams

export function teamInput(form: FormData) {
  return {
    name: required(form.get("name"), "Team name"),
    sport: clean(form.get("sport")),
    level: clean(form.get("level")),
  };
}

export async function saveTeam(
  db: PrismaClient,
  organizationId: number,
  id: number | null,
  input: ReturnType<typeof teamInput>,
  actor: string,
) {
  if (id === null) {
    const created = await db.team.create({ data: { organizationId, ...input } });
    await writeAudit(db, { entity: "team", entityId: created.id, action: "create", after: { organizationId, ...input }, actor });
    return created;
  }
  const before = await db.team.findUniqueOrThrow({ where: { id } });
  if (before.organizationId !== organizationId) throw new UserError("That team belongs to another organization.");
  const updated = await db.team.update({ where: { id }, data: input });
  await writeAudit(db, {
    entity: "team",
    entityId: id,
    action: "edit",
    before: { name: before.name, sport: before.sport, level: before.level },
    after: input,
    actor,
  });
  return updated;
}

// --------------------------------------------------------------- organizers

export function organizerInput(form: FormData) {
  const email = required(form.get("email"), "Email").toLowerCase();
  if (!EMAIL.test(email)) throw new UserError("That email doesn't look right.");
  return {
    name: required(form.get("name"), "Name"),
    email,
    phone: clean(form.get("phone")),
    role: clean(form.get("role")),
    notes: clean(form.get("notes")),
  };
}

export async function saveOrganizer(
  db: PrismaClient,
  id: number | null,
  input: ReturnType<typeof organizerInput>,
  actor: string,
) {
  const sameEmail = await db.organizer.findUnique({ where: { email: input.email } });
  if (sameEmail && sameEmail.id !== id) {
    throw new UserError(`${input.email} already belongs to ${sameEmail.name}.`);
  }
  if (id === null) {
    const created = await db.organizer.create({ data: input });
    await writeAudit(db, { entity: "organizer", entityId: created.id, action: "create", after: input, actor });
    return created;
  }
  const before = await db.organizer.findUniqueOrThrow({ where: { id } });
  const updated = await db.$transaction(async (tx) => {
    const row = await tx.organizer.update({ where: { id }, data: input });
    if (before.email !== input.email) {
      // Spec: changing an organizer's email signs them out everywhere.
      await tx.portalSession.updateMany({ where: { organizerId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await writeAudit(tx, {
      entity: "organizer",
      entityId: id,
      action: "edit",
      before: { name: before.name, email: before.email, phone: before.phone, role: before.role, notes: before.notes },
      after: input,
      actor,
    });
    return row;
  });
  return updated;
}
