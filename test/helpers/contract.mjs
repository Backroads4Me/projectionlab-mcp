// The Plugin API contract a fake bridge reports for its export: 2 for a
// ProjectionLab 5 export ({ schema, documents }), 1 otherwise. Mirrors
// detectLayout in src/layout.ts.
export function contractOf(data) {
  return data && typeof data.schema === "number" && data.documents && typeof data.documents === "object" ? 2 : 1;
}
