/** Physical metadata header only; body examples never select a model. */
export function parseIssueModelTier(body) {
  if (typeof body !== "string" || body.length > 60000) return { ok: false, error: "invalid" };
  const lines = body.replace(/\r\n/g, "\n").split("\n").map(line => line.trimEnd());
  const end = lines.findIndex(line => /^##\s/.test(line));
  const header = lines.slice(0, end < 0 ? lines.length : end);
  const markers = [];
  let fence;
  let comment = false;
  for (let i = 0; i < header.length; i++) {
    const line = header[i];
    if (comment) { if (line.includes("-->")) comment = false; continue; }
    if (line.trimStart().startsWith("<!--")) { comment = !line.includes("-->"); continue; }
    const delimiter = line.trimStart().match(/^(`{3,}|~{3,})/);
    if (delimiter) { if (!fence) fence = delimiter[1][0]; else if (fence === delimiter[1][0]) fence = undefined; continue; }
    if (!fence && /model[ -]tier/i.test(line)) markers.push(i);
  }
  if (markers.length > 1) return { ok: false, error: "duplicate" };
  if (!markers.length) return { ok: false, error: "missing" };
  if (markers[0] !== 1 || !(lines[0]?.startsWith("**Blocked by:** ") && lines[0].length > "**Blocked by:** ".length)) return { ok: false, error: "invalid-position" };
  const value = lines[1];
  if (value === "**Model tier:** low") return { ok: true, tier: "low" };
  if (value === "**Model tier:** medium") return { ok: true, tier: "medium" };
  if (value === "**Model tier:** high") return { ok: true, tier: "high" };
  return { ok: false, error: "invalid" };
}

/** Publishing also requires the human explanation, which never affects routing. */
export function validateIssueModelMetadata(body) {
  const parsed = parseIssueModelTier(body);
  if (!parsed.ok) return parsed;
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const contextStart = lines.findIndex(line => line.trimEnd() === "## Context");
  if (contextStart < 0) return { ok: false, error: "rationale-missing" };
  const nextHeading = lines.findIndex((line, index) => index > contextStart && /^##\s/.test(line));
  const context = lines.slice(contextStart + 1, nextHeading < 0 ? lines.length : nextHeading);
  const rationales = context.filter(line => /^Model tier rationale: \S/.test(line));
  if (rationales.length !== 1) return { ok: false, error: "rationale-missing" };
  return { ...parsed, rationale: rationales[0].slice("Model tier rationale: ".length).trim() };
}
