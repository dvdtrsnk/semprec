/**
 * Sent as `Prefer` on every Graph mail request, so a message keeps its id across folder moves; `provider_message_id`
 * of a Graph account holds this immutable id.
 */
export const GRAPH_IMMUTABLE_ID_PREFERENCE = 'IdType="ImmutableId"';
