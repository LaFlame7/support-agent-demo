import type { Queryable } from "../db/db.js";

export async function audit(
  q: Queryable,
  entry: { entity: string; entityId: number; action: string; actor: string; details?: object; at: Date },
) {
  await q.query(
    "insert into audit_log (entity, entity_id, action, actor, details, at) values ($1, $2, $3, $4, $5, $6)",
    [entry.entity, entry.entityId, entry.action, entry.actor, JSON.stringify(entry.details ?? {}), entry.at],
  );
}
