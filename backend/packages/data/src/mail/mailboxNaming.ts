import type { PoolClient } from "pg";

/**
 * The stored name a newly connected mailbox starts with: `preferred` (the provider's name, or the server's domain),
 * or the account's address when another live mailbox of the tenant already has that name, so two Gmail or two iCloud
 * accounts do not both show as the same name. The person may rename either afterwards.
 */
export async function newMailboxName(
  client: PoolClient,
  input: { mailboxesDatabaseId: string; preferred: string; address: string },
): Promise<string> {
  const { rows } = await client.query<{ taken: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM items
        WHERE database_id = $1 AND deleted_at IS NULL AND lower(properties ->> 'name') = lower($2)
     ) AS taken`,
    [input.mailboxesDatabaseId, input.preferred],
  );
  return rows[0]?.taken ? input.address : input.preferred;
}
