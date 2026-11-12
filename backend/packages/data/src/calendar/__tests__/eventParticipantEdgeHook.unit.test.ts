import { describe, expect, it } from "vitest";
import { ValidationError } from "../../errors.js";
import { parseEventParticipantMetadata, readEventParticipantMetadata } from "../eventParticipantEdgeHook.js";

const MAILBOX_ID = "6f1f8d0e-3c57-4a56-9d0b-2f8a3e3f4b11";
const INVITATION = { status: "pending", email: "petr@example.com", mailboxId: MAILBOX_ID };

/** The error a refused parse throws, narrowed so its code and details can be asserted. */
function refusal(metadata: Record<string, unknown> | undefined): ValidationError {
  try {
    parseEventParticipantMetadata(metadata);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("Expected the metadata to be refused");
}

describe("parseEventParticipantMetadata (issue #1757)", () => {
  it("reads absent metadata and {} as an edge without a role and without an invitation", () => {
    expect(parseEventParticipantMetadata(undefined)).toEqual({});
    expect(parseEventParticipantMetadata({})).toEqual({});
  });

  it.each(["organizer", "attendee"])("accepts the role %s alone", (role) => {
    expect(parseEventParticipantMetadata({ role })).toEqual({ role });
  });

  it.each(["pending", "accepted", "tentative", "declined"])("accepts an invitation with status %s", (status) => {
    const invitation = { ...INVITATION, status };
    expect(parseEventParticipantMetadata({ invitation })).toEqual({ invitation });
  });

  it("accepts an attendee's invitation with both instants", () => {
    const invitation = { ...INVITATION, sentAt: "2026-11-11T08:00:00Z", respondedAt: "2026-11-11T09:30:00.250Z" };
    expect(parseEventParticipantMetadata({ role: "attendee", invitation })).toEqual({ role: "attendee", invitation });
  });

  it.each<[string, Record<string, unknown>]>([
    ["a key other than role and invitation", { note: "x" }],
    ["an unknown key next to a valid role", { role: "attendee", addedAt: "2026-11-11T08:00:00Z" }],
    ["a role outside the two roles", { role: "owner" }],
    ["a role that is not a string", { role: null }],
    ["an invitation that is not an object", { invitation: "pending" }],
    ["a null invitation", { invitation: null }],
    ["an invitation status outside the four statuses", { invitation: { ...INVITATION, status: "sent" } }],
    ["an invitation without an email", { invitation: { status: "pending", mailboxId: MAILBOX_ID } }],
    ["an invitation with an empty email", { invitation: { ...INVITATION, email: "" } }],
    ["an invitation without a mailbox", { invitation: { status: "pending", email: "petr@example.com" } }],
    ["an invitation whose mailbox is not a UUID", { invitation: { ...INVITATION, mailboxId: "mailbox" } }],
    ["a sentAt that is not an instant", { invitation: { ...INVITATION, sentAt: "2026-11-11" } }],
    ["a respondedAt with a zone offset", { invitation: { ...INVITATION, respondedAt: "2026-11-11T09:30:00+01:00" } }],
    ["an unknown key inside the invitation", { invitation: { ...INVITATION, note: "x" } }],
    ["an invitation on an organizer edge", { role: "organizer", invitation: INVITATION }],
  ])("refuses %s with validation_failed on metadata", (_label, metadata) => {
    const error = refusal(metadata);
    expect(error.status).toBe(400);
    expect(error.code).toBe("validation_failed");
    expect(error.details).toEqual({ field: "metadata", reason: "invalidParticipantMetadata" });
  });
});

describe("readEventParticipantMetadata (issue #1757)", () => {
  it("reads {} as an attendee without an invitation", () => {
    expect(readEventParticipantMetadata({})).toEqual({ role: "attendee", invitation: null });
  });

  it("reads a stored organizer role", () => {
    expect(readEventParticipantMetadata({ role: "organizer" })).toEqual({ role: "organizer", invitation: null });
  });

  it("reads a stored invitation next to the role", () => {
    const invitation = { ...INVITATION, status: "accepted", respondedAt: "2026-11-11T09:30:00Z" };
    expect(readEventParticipantMetadata({ role: "attendee", invitation })).toEqual({ role: "attendee", invitation });
  });

  it("reads a stored role outside the two roles as attendee and keeps the invitation", () => {
    expect(readEventParticipantMetadata({ role: "owner", invitation: INVITATION })).toEqual({
      role: "attendee",
      invitation: INVITATION,
    });
  });

  it("reads a stored invitation of another shape as none and keeps the role", () => {
    expect(readEventParticipantMetadata({ role: "organizer", invitation: { status: "sent" } })).toEqual({
      role: "organizer",
      invitation: null,
    });
  });
});
